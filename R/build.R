# Year build: regional reference traces (fixed annual basket), weekly settlement components for the fleet tab,
# unit merchant components, and the WDB1 files. One call builds every region for one calendar year.
#
# Reference trace, per region x tech x 5-min interval:
#   basket  = units of that tech in the region, registered by 1 Jan, not deregistered, and first generating
#             on or before 1 July of the prior year (>= 6 months operational when the basket is set)
#   cap_j   = registered capacity in force on 1 Jan (fixed for the year)
#   SO      : sum_j clamp(SCADA_j, 0, cap_j) / sum_j cap_j            over basket units with valid data
#   UIGF    : as SO, but UIGF_j (AVAILABILITY where UIGF is missing) replaces SCADA_j when the regional price < 0
#   A unit with missing data in an interval is dropped from numerator and denominator for that interval only.
# Settlement (per MW of contract, cap X = 600, floor F = 0), summed by billing week:
#   A1 naive     : CF * (K - P)
#   A2 cap+floor : CF * (K - clamp(P, F, X))
#   A3 knockout  : CF * 1[P >= 0] * (K - min(P, X))
#   stored as A = sum CF*m*dt and B = sum CF*m*P'*dt, so any K gives K*A - B
# Merchant (per unit): sum max(SCADA,0) * max(P,0) * dt  (floored at zero when the price is negative)

REF_SUN <- as.numeric(as.POSIXct("2016-12-25 00:00", tz = "UTC"))   # a Sunday before any reporting week; NEM billing weeks run Sun-Sat (must match site/app.js)
BLOCK   <- 16L
H       <- DT_SEC / 3600
CAP_X   <- 600; FLOOR_F <- 0
TECHS   <- c("wind", "solar")
RT_FIELDS <- c(paste0(rep(c("so", "ug"), each = 6), "_", rep(rep(c("a1", "a2", "a3"), each = 2), 2), "_", c("A", "B")), "nint", "nneg")
U_FIELDS  <- c("EG", "MG", "MGraw", "nvalid")

year_window <- function(y, off = NEM_OFF) {
  c(as.numeric(as.POSIXct(sprintf("%d-01-01 00:05", y), tz = "UTC")) - off,
    as.numeric(as.POSIXct(sprintf("%d-01-01 00:00", y + 1), tz = "UTC")) - off)
}

basket_for <- function(units, caph, y) {
  jan1 <- as.Date(sprintf("%d-01-01", y)); cut6 <- as.Date(sprintf("%d-07-01", y - 1))
  b <- units[!is.na(first_op) & first_op <= cut6 & (is.na(reg_date) | reg_date <= jan1) & end_date > jan1, .(duid, region, tech)]
  b[, cap_jan := cap_at(caph, duid, jan1)]
  b[]
}

# months: list of month objects (scada, disp, price) covering year y; units: register (region, tech, duid, ...) in block order
build_year <- function(y, months, units, caph, out_dir, data_end) {
  win <- year_window(y); t0 <- win[1]; tN <- min(win[2], data_end)
  if (tN < t0) return(NULL)
  n <- as.integer(round((tN - t0) / DT_SEC)) + 1L; tt <- t0 + (seq_len(n) - 1) * DT_SEC
  ix <- function(t) as.integer(round((t - t0) / DT_SEC)) + 1L
  sc <- rbindlist(lapply(months, `[[`, "scada"), use.names = TRUE)[t >= t0 & t <= tN]
  dp <- rbindlist(lapply(months, `[[`, "disp"), use.names = TRUE)[t >= t0 & t <= tN]
  pr <- rbindlist(lapply(months, `[[`, "price"), use.names = TRUE)[t >= t0 & t <= tN]
  setkey(sc, duid); setkey(dp, duid)
  basket <- basket_for(units, caph, y)

  tb <- tt + NEM_OFF - DT_SEC
  wk <- as.integer(floor((tb - REF_SUN) / 604800))
  wsum <- function(M) t(rowsum(t(M), wk, reorder = TRUE))
  wsumv <- function(v) { r <- rowsum(v, wk, reorder = TRUE); setNames(r[, 1], rownames(r)) }

  res <- list(year = y, n = n, data_end = tN, rt = list(), unit = list(), files = list(idx = list(), unit = list()),
              basket = list())
  for (r in unique(units$region)) {
    ur <- units[region == r]; nu <- nrow(ur)
    fill <- function(d, col) { M <- matrix(NA_real_, nu, n); k <- match(d$duid, ur$duid); i <- ix(d$t); ok <- !is.na(k) & i >= 1 & i <= n; M[cbind(k[ok], i[ok])] <- d[[col]][ok]; M }
    s_r <- sc[J(ur$duid), nomatch = 0L]; d_r <- dp[J(ur$duid), nomatch = 0L]
    SO <- fill(s_r, "so"); CL <- fill(d_r, "cleared"); AV <- fill(d_r, "avail"); UG <- fill(d_r, "uigf")
    UGf <- ifelse(is.na(UG), AV, UG)                              # UIGF, or AVAILABILITY where UIGF isn't published
    P <- rep(NA_real_, n); p_r <- pr[region == r]; P[ix(p_r$t)] <- p_r$rrp
    neg <- !is.na(P) & P < 0
    Pv <- !is.na(P); P0 <- ifelse(Pv, P, 0)
    traces <- list()
    for (tech in TECHS) {
      tch <- tech; bm <- basket[region == r & basket$tech == tch]
      k <- match(bm$duid, ur$duid); k <- k[!is.na(k)]; capj <- bm$cap_jan[match(ur$duid[k], bm$duid)]
      res$basket[[r]][[tech]] <- list(n = length(k), cap = sum(capj), duids = ur$duid[k])
      if (!length(k)) { traces[[tech]] <- list(so = rep(NA_real_, n), ug = rep(NA_real_, n)); next }
      S <- SO[k, , drop = FALSE]; U <- UGf[k, , drop = FALSE]
      vs <- !is.na(S); xs <- ifelse(vs, pmin(pmax(S, 0), capj), 0)
      negm <- matrix(neg, length(k), n, byrow = TRUE)
      vu <- ifelse(negm, !is.na(U), vs); xu <- ifelse(negm, ifelse(is.na(U), 0, pmin(pmax(U, 0), capj)), xs)
      den_s <- colSums(vs * capj); den_u <- colSums(vu * capj)
      traces[[tech]] <- list(so = ifelse(den_s > 0, colSums(xs) / den_s, NA_real_), ug = ifelse(den_u > 0, colSums(xu) / den_u, NA_real_))
      # fleet settlement components per MW of contract
      comp <- list()
      for (v in c("so", "ug")) {
        cf <- traces[[tech]][[v]]; ok <- !is.na(cf) & Pv; c0 <- ifelse(ok, cf, 0)
        p1 <- P0; p2 <- pmin(pmax(P0, FLOOR_F), CAP_X); p3 <- pmin(P0, CAP_X); m3 <- as.numeric(P0 >= 0)
        comp[[paste0(v, "_a1_A")]] <- wsumv(c0 * H);      comp[[paste0(v, "_a1_B")]] <- wsumv(c0 * p1 * H)
        comp[[paste0(v, "_a2_A")]] <- wsumv(c0 * H);      comp[[paste0(v, "_a2_B")]] <- wsumv(c0 * p2 * H)
        comp[[paste0(v, "_a3_A")]] <- wsumv(c0 * m3 * H); comp[[paste0(v, "_a3_B")]] <- wsumv(c0 * m3 * p3 * H)
        if (v == "so") { comp$nint <- wsumv(as.numeric(ok)); comp$nneg <- wsumv(as.numeric(ok & neg)) }
      }
      res$rt[[paste(r, tech, sep = "_")]] <- as.data.table(c(list(region = r, tech = tech, wk = as.integer(names(comp$nint))), comp[RT_FIELDS]))
    }
    # unit merchant components
    G <- ifelse(!is.na(SO) & matrix(Pv, nu, n, byrow = TRUE), pmax(SO, 0), 0)
    PM <- matrix(P0, nu, n, byrow = TRUE)
    um <- list(EG = wsum(G) * H, MG = wsum(G * pmax(PM, 0)) * H, MGraw = wsum(G * PM) * H, nvalid = wsum((!is.na(SO) & matrix(Pv, nu, n, byrow = TRUE)) * 1))
    wks <- as.integer(colnames(um$EG))
    res$unit[[r]] <- rbindlist(lapply(seq_len(nu), function(j) as.data.table(c(list(duid = ur$duid[j], wk = wks), lapply(um, function(M) M[j, ])))))

    # ---- files ----
    hdr <- list(region = r, year = y, t0 = t0, dt = DT_SEC, n = n)
    blobs <- list(enc_f32(P)); ser <- list(list(id = "rrp", kind = "price", enc = "f32", gaps = list()))
    for (tech in TECHS) for (v in c("so", "ug")) {
      e <- enc_d16s(traces[[tech]][[v]], CF_SCALE); blobs <- c(blobs, list(e$bytes))
      ser <- c(ser, list(list(id = paste(tech, v, sep = "_"), kind = "cf", enc = "d16s", scale = CF_SCALE, gaps = e$gaps)))
    }
    fn <- sprintf("idx/%s_%d.bin", r, y)
    res$files$idx[[sprintf("%s_%d", r, y)]] <- list(file = fn, bytes = write_wdb(file.path(out_dir, fn), hdr, blobs, ser))
    for (k0 in seq(1L, nu, by = BLOCK)) {
      ks <- k0:min(nu, k0 + BLOCK - 1L); blobs <- list(); ser <- list()
      for (j in ks) {
        id <- ur$duid[j]; q <- function(x) round(x / MW_SCALE) * MW_SCALE
        so <- q(SO[j, ]); base <- ifelse(is.na(so), 0, so)
        e <- list(so = enc_d16s(so, MW_SCALE), cl = enc_d16s(q(CL[j, ]) - base, MW_SCALE),
                  av = enc_d16s(q(AV[j, ]) - base, MW_SCALE), ug = enc_d16s(q(UGf[j, ]) - base, MW_SCALE))
        for (nm in names(e)) {
          blobs <- c(blobs, list(e[[nm]]$bytes))
          ser <- c(ser, list(c(list(id = paste0(id, ":", nm), kind = nm, enc = "d16s", scale = MW_SCALE, gaps = e[[nm]]$gaps),
                               if (nm != "so") list(base = paste0(id, ":so")) else list())))
        }
      }
      key <- sprintf("%s_%d_b%d", r, y, (k0 - 1L) %/% BLOCK); fn <- sprintf("unit/%s.bin", key)
      res$files$unit[[key]] <- list(file = fn, bytes = write_wdb(file.path(out_dir, fn), hdr, blobs, ser))
    }
    rm(SO, CL, AV, UG, UGf, G, PM); gc(verbose = FALSE)
  }
  res
}

# ---- combine all years into settle.bin and meta.json ----
assemble <- function(units, derived, out_dir, n_weeks, extra_meta = list(), caph_all = NULL) {
  rts <- unique(rbindlist(lapply(derived, function(d) rbindlist(lapply(d$rt, function(x) x[1, .(region, tech)])))))
  setorder(rts, region, tech); rts[, ri := seq_len(.N) - 1L]
  agg <- function(dt, keys, fields, ids) {
    dt <- dt[wk >= 0 & wk < n_weeks, lapply(.SD, sum), by = c(keys, "wk"), .SDcols = fields]
    full <- ids[, .(wk = 0:(n_weeks - 1L)), by = keys]
    dt <- dt[full, on = c(keys, "wk")]
    for (f in fields) set(dt, which(is.na(dt[[f]])), f, 0)
    dt
  }
  flat <- function(dt, fields, nrow_) { M <- as.matrix(dt[, ..fields]); as.vector(aperm(array(M, c(n_weeks, nrow_, length(fields))), c(1, 3, 2))) }
  RT <- agg(rbindlist(lapply(derived, function(d) rbindlist(d$rt))), c("region", "tech"), RT_FIELDS, rts[, .(region, tech)])
  RT <- rts[RT, on = c("region", "tech")][order(ri, wk)]
  UT <- agg(rbindlist(lapply(derived, function(d) rbindlist(d$unit))), "duid", U_FIELDS, units[, .(duid)])
  UT[, gi := units$gi[match(duid, units$duid)]]; setorder(UT, gi, wk)
  weeks <- format(as.Date(as.POSIXct(REF_SUN, origin = "1970-01-01", tz = "UTC")) + 7 * (0:(n_weeks - 1L)))
  sz <- write_wdb(file.path(out_dir, "settle.bin"), list(weeks = weeks, cap = CAP_X, floor = FLOOR_F),
                  list(enc_f32(flat(UT, U_FIELDS, nrow(units))), enc_f32(flat(RT, RT_FIELDS, nrow(rts)))),
                  list(list(id = "U", shape = c(nrow(units), length(U_FIELDS), n_weeks), enc = "f32", fields = U_FIELDS),
                       list(id = "R", shape = c(nrow(rts), length(RT_FIELDS), n_weeks), enc = "f32", fields = RT_FIELDS)))
  baskets <- setNames(lapply(derived, function(d) d$basket), vapply(derived, function(d) as.character(d$year), ""))
  member <- function(id) as.integer(names(baskets)[vapply(baskets, function(b) any(vapply(b, function(rr) any(vapply(rr, function(x) id %in% x$duids, TRUE)), TRUE)), TRUE)])
  meta <- c(list(version = 2L, dt = DT_SEC, years = I(as.integer(names(baskets))), params = list(cap = CAP_X, floor = FLOOR_F)), extra_meta,
            list(regions = lapply(sort(unique(units$region)), function(r) list(id = r, utc_offset = 10L,
                                     n_wind = sum(units$region == r & units$tech == "wind"), n_solar = sum(units$region == r & units$tech == "solar"))),
                 rt = lapply(seq_len(nrow(rts)), function(i) list(region = rts$region[i], tech = rts$tech[i])),
                 units = lapply(seq_len(nrow(units)), function(i) {
                   u <- units[i]
                   list(id = u$duid, name = u$name, region = u$region, tech = u$tech, cap = u$cap,
                        reg_date = if (is.na(u$reg_date)) NULL else format(u$reg_date),
                        first_gen = if (is.na(u$first_gen)) NULL else format(u$first_gen),
                        first_op = if (is.na(u$first_op)) NULL else format(u$first_op),
                        member = I(member(u$duid)), block = u$block, slot = u$slot, gi = u$gi)
                 }),
                 baskets = lapply(baskets, function(b) lapply(b, function(rr) lapply(rr, function(x) list(n = x$n, cap = round(x$cap, 1))))),
                 idx = do.call(c, lapply(derived, function(d) d$files$idx)),
                 unit_parts = do.call(c, lapply(derived, function(d) d$files$unit)),
                 settle = list(file = "settle.bin", bytes = sz)))
  # basket membership for checking: one row per year x unit, with the date and basis used for the 6-month rule
  bl <- rbindlist(lapply(names(baskets), function(y) rbindlist(lapply(names(baskets[[y]]), function(r) rbindlist(lapply(names(baskets[[y]][[r]]), function(tk)
    if (length(baskets[[y]][[r]][[tk]]$duids)) data.table(year = as.integer(y), region = r, tech = tk, duid = baskets[[y]][[r]][[tk]]$duids)))))))
  if (nrow(bl)) {
    bl <- units[, .(duid, name, cap_now = cap, reg_date, first_gen, first_op, end_date)][bl, on = "duid"]
    bl[, cap_jan := cap_at(caph_all, duid, as.Date(sprintf("%d-01-01", year))), by = year]
    bl[, basis := fifelse(!is.na(first_gen) & first_op < first_gen, "registration date (already generating when the fetched history starts)", "first SCADA >= 1 MW")]
    bl[end_date >= as.Date("2999-01-01"), end_date := NA]
    setcolorder(bl, c("year", "region", "tech", "duid", "name", "cap_jan", "reg_date", "first_gen", "first_op", "basis", "end_date"))
    fwrite(bl[order(year, region, tech, duid), !"cap_now"], file.path(out_dir, "baskets.csv"))
  }
  jsonlite::write_json(meta, file.path(out_dir, "meta.json"), auto_unbox = TRUE, digits = NA, null = "null", na = "null")
  invisible(meta)
}

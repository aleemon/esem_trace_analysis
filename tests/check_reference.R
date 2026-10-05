#!/usr/bin/env Rscript
# Independent check of the build: recomputes the basket, reference traces, fleet settlement components and merchant
# for one region-year straight from the cached month files (long-format data.table, no matrices), and compares them
# with what run.R wrote. Usage: Rscript tests/check_reference.R <year> <region> [cache_dir]
suppressPackageStartupMessages({ library(data.table); library(jsonlite) })
source("R/wdb.R")
a <- commandArgs(TRUE); y <- as.integer(a[1]); r <- a[2]; cache <- if (length(a) > 2) a[3] else "cache"
OFF <- 36000; H <- 1 / 12; CAPX <- 600; FL <- 0
REF <- as.numeric(as.POSIXct("2016-12-25", tz = "UTC"))
meta <- fromJSON(file.path(cache, "out", "meta.json"), simplifyVector = FALSE)
units <- rbindlist(lapply(meta$units, function(u) data.table(duid = u$id, region = u$region, tech = u$tech, gi = u$gi,
  reg_date = as.Date(u$reg_date %||% NA), first_op = as.Date(u$first_op %||% NA))))
reg <- readRDS(file.path(cache, "register.rds"))   # register + dated capacity history, saved by run.R
caph <- reg$caph

# ---- first generation recomputed from every cached month ----
mf <- sort(list.files(file.path(cache, "nem"), "^[0-9]{6}\\.rds$", full.names = TRUE))
fg <- rbindlist(lapply(mf, function(f) readRDS(f)$scada[so >= 1, .(t = min(t)), by = duid]))[, .(t = min(t)), by = duid]
h0 <- min(vapply(mf, function(f) min(readRDS(f)$price$t), 0))
fg[, d := as.Date(as.POSIXct(t + OFF - 300, origin = "1970-01-01", tz = "UTC"))]
chk_units <- merge(units, fg[, .(duid, d)], by = "duid", all.x = TRUE)
chk_units[, op := fifelse(!is.na(d) & d <= as.Date(as.POSIXct(h0 + OFF, origin = "1970-01-01", tz = "UTC")) + 7, pmin(reg_date, d, na.rm = TRUE), d)]
stopifnot("first_op mismatch" = all(chk_units$op == chk_units$first_op | (is.na(chk_units$op) & is.na(chk_units$first_op))))

# ---- basket ----
jan1 <- as.Date(sprintf("%d-01-01", y)); cut6 <- as.Date(sprintf("%d-07-01", y - 1))
bk <- units[region == r & !is.na(first_op) & first_op <= cut6 & (is.na(reg_date) | reg_date <= jan1)]
bk[, cap := vapply(duid, function(d) { h <- caph[duid == d][order(eff)]; if (any(h$eff <= jan1)) h$cap[max(which(h$eff <= jan1))] else h$cap[1] }, 0)]

# ---- long-format data for the year ----
t0 <- as.numeric(as.POSIXct(sprintf("%d-01-01 00:05", y), tz = "UTC")) - OFF
t1 <- as.numeric(as.POSIXct(sprintf("%d-01-01 00:00", y + 1), tz = "UTC")) - OFF
keys <- c(sprintf("%d%02d", y, 1:12), sprintf("%d01", y + 1)); keys <- keys[file.exists(file.path(cache, "nem", paste0(keys, ".rds")))]
mm <- lapply(keys, function(k) readRDS(file.path(cache, "nem", paste0(k, ".rds"))))
sc <- rbindlist(lapply(mm, `[[`, "scada"), use.names = TRUE)[t >= t0 & t <= t1]
dp <- rbindlist(lapply(mm, `[[`, "disp"), use.names = TRUE)[t >= t0 & t <= t1]
pr <- rbindlist(lapply(mm, `[[`, "price"), use.names = TRUE)[t >= t0 & t <= t1 & region == r, .(t, rrp)]
grid <- data.table(t = seq(t0, min(t1, max(pr$t)), by = 300))
res <- list()
for (tch in c("wind", "solar")) {
  b <- bk[tech == tch]
  if (!nrow(b)) next
  L <- CJ(t = grid$t, duid = b$duid)
  L <- sc[L, on = .(t, duid)]; L <- dp[L, on = .(t, duid)]; L <- pr[L, on = "t"]; L <- b[, .(duid, cap)][L, on = "duid"]
  L[, u := fifelse(is.na(uigf), avail, uigf)]
  L[, neg := !is.na(rrp) & rrp < 0]
  tr <- L[, .(so = sum(pmin(pmax(so[!is.na(so)], 0), cap[!is.na(so)])) / sum(cap[!is.na(so)]),
              ug = { v <- fifelse(neg, !is.na(u), !is.na(so)); x <- fifelse(neg, pmin(pmax(u, 0), cap), pmin(pmax(so, 0), cap)); sum(x[v]) / sum(cap[v]) },
              rrp = rrp[1]), by = t][order(t)]
  # compare with the published trace file
  w <- read_wdb(file.path(cache, "out", sprintf("idx/%s_%d.bin", r, y)))
  for (v in c("so", "ug")) {
    pub <- decode_series(w, paste(tch, v, sep = "_"))[seq_len(nrow(tr))]
    dmax <- max(abs(pub - tr[[v]]), na.rm = TRUE)
    res[[paste("trace", tch, v)]] <- c(dmax, dmax < 6e-5 && identical(is.na(pub), is.na(tr[[v]]) | !is.finite(tr[[v]])))
  }
  # fleet settlement components (week sums), compared with settle.bin R
  tr[, wk := floor((t + OFF - 300 - REF) / 604800)]
  st <- read_wdb(file.path(cache, "out", "settle.bin")); sR <- st$h$series[[2]]
  Rv <- readBin(st$raw[(st$body + sR$off + 1):(st$body + sR$off + sR$len)], "numeric", sR$len / 4, size = 4, endian = "little")
  dimR <- unlist(sR$shape); ri <- which(vapply(meta$rt, function(x) x$region == r && x$tech == tch, TRUE)) - 1L
  fields <- unlist(sR$fields)
  pick_r <- function(f, wks) Rv[ri * dimR[2] * dimR[3] + (match(f, fields) - 1) * dimR[3] + wks + 1]
  for (v in c("so", "ug")) {
    d <- tr[is.finite(tr[[v]]) & !is.na(rrp)]
    d[, cf := d[[v]]]
    d[, `:=`(a1A = cf * H, a1B = cf * rrp * H, a2B = cf * pmin(pmax(rrp, FL), CAPX) * H, a3A = cf * (rrp >= 0) * H, a3B = cf * (rrp >= 0) * pmin(rrp, CAPX) * H)]
    ws <- d[, .(a1A = sum(a1A), a1B = sum(a1B), a2B = sum(a2B), a3A = sum(a3A), a3B = sum(a3B)), by = wk]
    # weeks fully inside the year (edge weeks also contain the neighbouring year's intervals)
    ws <- ws[wk > min(wk) & wk < max(wk)]
    for (f in c("a1A", "a1B", "a2B", "a3A", "a3B")) {
      nm <- sprintf("%s_%s_%s", v, substr(f, 1, 2), substr(f, 3, 3))
      pub <- pick_r(nm, ws$wk); ref <- ws[[f]]
      rel <- max(abs(pub - ref)) / max(1, max(abs(ref)))
      res[[paste("weekly", tch, nm)]] <- c(rel, rel < 1e-5)
    }
  }
}
# merchant for every unit in the region (sum over the full weeks of the year)
L <- sc[duid %chin% units[region == r]$duid]; L <- pr[L, on = "t", nomatch = 0L][!is.na(rrp) & !is.na(so)]
L[, wk := floor((t + OFF - 300 - REF) / 604800)]
inner <- L[, unique(wk)]; inner <- inner[inner > min(inner) & inner < max(inner)]
mg <- L[wk %in% inner, .(MG = sum(pmax(so, 0) * pmax(rrp, 0)) * H, EG = sum(pmax(so, 0)) * H), by = duid]
st <- read_wdb(file.path(cache, "out", "settle.bin")); sU <- st$h$series[[1]]
Uv <- readBin(st$raw[(st$body + sU$off + 1):(st$body + sU$off + sU$len)], "numeric", sU$len / 4, size = 4, endian = "little")
dU <- unlist(sU$shape); fU <- unlist(sU$fields)
mg[, gi := units$gi[match(duid, units$duid)]]
mg[, pubMG := vapply(gi, function(g) sum(Uv[g * dU[2] * dU[3] + (match("MG", fU) - 1) * dU[3] + inner + 1]), 0)]
mg[, pubEG := vapply(gi, function(g) sum(Uv[g * dU[2] * dU[3] + (match("EG", fU) - 1) * dU[3] + inner + 1]), 0)]
rel <- max(abs(mg$pubMG - mg$MG) / pmax(1, abs(mg$MG))); res[["merchant MG"]] <- c(rel, rel < 1e-5)
rel <- max(abs(mg$pubEG - mg$EG) / pmax(1, abs(mg$EG))); res[["merchant EG"]] <- c(rel, rel < 1e-5)
cat(sprintf("basket %s %d: wind %d (%.0f MW), solar %d (%.0f MW)\n", r, y, sum(bk$tech == "wind"), sum(bk[tech == "wind"]$cap), sum(bk$tech == "solar"), sum(bk[tech == "solar"]$cap)))
mb <- meta$baskets[[as.character(y)]][[r]]
stopifnot("basket size mismatch" = (mb$wind$n %||% 0) == sum(bk$tech == "wind") && (mb$solar$n %||% 0) == sum(bk$tech == "solar"))
for (k in names(res)) cat(sprintf("%-5s %-28s max diff %.3g\n", if (res[[k]][2] == 1) "PASS" else "FAIL", k, res[[k]][1]))
if (any(vapply(res, function(x) x[2] != 1, TRUE))) quit(status = 1)
cat("ALL PASS\n")

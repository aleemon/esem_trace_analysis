# Shaping contract data: predispatch (PD) regional price and residual demand as seen at hourly nomination runs on the
# day before (D-1, 08:00-20:00 market time), and the actual 30-min spot price, per region and calendar day D.
#
#   residual demand = PD TOTALDEMAND - SS_SOLAR_UIGF - SS_WIND_UIGF   (PREDISPATCHREGIONSUM)
#   PD price        = PREDISPATCHPRICE.RRP                             (intervention 0)
#   actual          = mean of the 5-min regional price over each half-hour (the trading price before 5MS)
#
# Per day the page gets 56 half-hours ending D 00:30 ... D+1 04:00 (the end of trading day D), for each of 13 runs.
# A PD run only reaches the end of the next trading day from about 12:30, so runs before then leave most of D empty.
# PREDISPATCHSEQNO = YYYYMMDDPP (trading date, PP = 01 for the run at 04:30): the run time used as the nomination time.

SHP_RUNS <- 8:20
SHP_NP   <- 56L
pp_of    <- function(h) 2L * h - 8L                                       # 16:00 -> 24
seq_time <- function(s) { s <- chr(s); as.numeric(as.POSIXct(substr(s, 1, 8), format = "%Y%m%d", tz = "UTC")) + 4 * 3600 + as.integer(substr(s, 9, 10)) * 1800 - NEM_OFF }
day0     <- function(d) as.numeric(as.POSIXct(format(d), tz = "UTC")) - NEM_OFF     # market midnight of date d, as stored t
seqnos_for <- function(dates) as.vector(outer(format(dates, "%Y%m%d"), sprintf("%02d", pp_of(SHP_RUNS)), paste0))

PD_PRICE_KEEP <- c("PREDISPATCHSEQNO", "REGIONID", "INTERVENTION", "DATETIME", "RRP")
PD_RS_KEEP    <- c("PREDISPATCHSEQNO", "REGIONID", "INTERVENTION", "DATETIME", "TOTALDEMAND")
PD_RS_OPT     <- c("SS_SOLAR_UIGF", "SS_WIND_UIGF")

shape_pd <- function(pr, rs) {
  if (is.null(pr) || is.null(rs)) return(NULL)
  p <- unique(pr[num(INTERVENTION) == 0, .(run = seq_time(PREDISPATCHSEQNO), t = aemo_time(DATETIME), region = chr(REGIONID), rrp = num(RRP))], by = c("run", "t", "region"))
  r <- unique(rs[num(INTERVENTION) == 0, .(run = seq_time(PREDISPATCHSEQNO), t = aemo_time(DATETIME), region = chr(REGIONID),
                                           dem = num(TOTALDEMAND), sol = num(SS_SOLAR_UIGF), wnd = num(SS_WIND_UIGF))], by = c("run", "t", "region"))
  merge(p, r, by = c("run", "t", "region"), all = TRUE)
}

# ---------- MMSDM PREDISP_ALL_DATA (every run, one file set per month of run dates) ----------
pd_files <- function(y, m) {
  url <- sprintf("%s/%d/MMSDM_%d_%02d/MMSDM_Historical_Data_SQLLoader/PREDISP_ALL_DATA/", MMSDM, y, y, m)
  f <- list_dir(url); f <- f[grepl("\\.zip$", f, ignore.case = TRUE)]
  pk <- function(tb) f[grepl(sprintf("(PUBLIC_DVD_%s[0-9]?_|PUBLIC_ARCHIVE#%s#ALL#FILE[0-9]+#)[0-9]{12}\\.zip$", tb, tb), f)]
  list(url = url, files = f, price = pk("PREDISPATCHPRICE"), rs = pk("PREDISPATCHREGIONSUM"))
}
fetch_pd_mmsdm <- function(y, m, tmp) {
  L <- pd_files(y, m)
  if (!length(L$files)) stop("PREDISP_ALL_DATA listing empty or unreachable: ", L$url)
  if (!length(L$price) || !length(L$rs)) stop("PREDISPATCHPRICE / PREDISPATCHREGIONSUM not found in ", L$url)
  m0 <- as.Date(sprintf("%d-%02d-01", y, m)); sq <- seqnos_for(seq(m0 - 1, seq(m0, by = "month", length.out = 2)[2], by = "day"))
  get <- function(files, keep, opt = character()) rbindlist(lapply(files, function(f) {
    z <- download(paste0(L$url, enc_name(f)), file.path(tmp, f)); on.exit(unlink(z))
    read_aemo(z, NULL, keep, duids = sq, opt = opt)
  }), fill = TRUE)
  log_msg("PD MMSDM %d-%02d", y, m)
  x <- shape_pd(get(L$price, PD_PRICE_KEEP), get(L$rs, PD_RS_KEEP, PD_RS_OPT))
  if (!NROW(x)) stop("PD tables read as empty")
  x
}

# ---------- weekly PredispatchIS archive (months MMSDM hasn't published yet) ----------
# PUBLIC_PREDISPATCHIS_<from>_<to>.zip holds one zip per run; only the nomination-hour runs are extracted.
pd_week <- function(name, tmp, cache_dir) {
  f <- file.path(cache_dir, "pd", "weeks", sub("\\.zip$", ".rds", name))
  if (file.exists(f)) return(readRDS(f))
  url <- paste0(NEMWEB, "/Reports/Archive/PredispatchIS_Reports/", name)
  z <- download(url, file.path(tmp, name)); on.exit(unlink(z))
  inner <- system(sprintf("unzip -Z1 %s", shQuote(z)), intern = TRUE)
  want <- inner[grepl(sprintf("_[0-9]{8}(%s)00_", paste(sprintf("%02d", SHP_RUNS), collapse = "|")), inner)]
  if (!length(want)) want <- inner
  d <- tempfile("pdw"); dir.create(d); on.exit(unlink(d, recursive = TRUE), add = TRUE)
  lst <- tempfile(fileext = ".txt"); writeLines(want, lst)
  system(sprintf("unzip -q -o %s -d %s $(cat %s)", shQuote(z), shQuote(d), shQuote(lst)))
  cc <- sprintf("for f in %s/*.zip; do unzip -p \"$f\"; done", shQuote(d))
  rng <- as.Date(regmatches(name, gregexpr("[0-9]{8}", name))[[1]], "%Y%m%d")
  sq <- seqnos_for(seq(rng[1] - 1, rng[2] + 1, by = "day"))
  log_msg("PD weekly %s (%d runs)", name, length(want))
  x <- shape_pd(read_aemo(name, "PREDISPATCH,REGION_PRICES,", PD_PRICE_KEEP, duids = sq, cat_cmd = cc),
                read_aemo(name, "PREDISPATCH,REGION_SOLUTION,", PD_RS_KEEP, duids = sq, opt = PD_RS_OPT, cat_cmd = cc))
  if (!NROW(x)) stop("weekly PD tables read as empty: ", name)
  dir.create(dirname(f), recursive = TRUE, showWarnings = FALSE); saveRDS(x, f)
  x
}
fetch_pd_weekly <- function(y, m, tmp, cache_dir) {
  m0 <- as.Date(sprintf("%d-%02d-01", y, m)); m1 <- seq(m0, by = "month", length.out = 2)[2] - 1
  ls <- list_dir(paste0(NEMWEB, "/Reports/Archive/PredispatchIS_Reports/"))
  ls <- unique(ls[grepl("^PUBLIC_PREDISPATCHIS_[0-9]{8}_[0-9]{8}\\.zip$", ls)])
  if (!length(ls)) stop("weekly PredispatchIS archive listing empty or unreachable")
  a <- as.Date(substr(ls, 22, 29), "%Y%m%d"); b <- as.Date(substr(ls, 31, 38), "%Y%m%d")
  ls <- ls[b >= m0 - 1 & a <= m1]
  if (!length(ls)) stop("no weekly PredispatchIS archives for this month yet")
  rbindlist(lapply(ls, pd_week, tmp = tmp, cache_dir = cache_dir))
}

# month entry point: cache/pd/YYYYMM.rds; MMSDM months are kept, weekly-built months are rebuilt until MMSDM has them
fetch_pd_month <- function(y, m, cache_dir, today = Sys.Date()) {
  f <- file.path(cache_dir, "pd", sprintf("%d%02d.rds", y, m))
  if (file.exists(f)) { x <- readRDS(f); if (isTRUE(x$complete)) { note_fetch(y, m, "cached", "", log = "pd"); return(x) } }
  tmp <- tempfile("pd"); dir.create(tmp); on.exit(unlink(tmp, recursive = TRUE))
  err <- ""
  d <- tryCatch(fetch_pd_mmsdm(y, m, tmp), error = function(e) { err <<- conditionMessage(e); NULL })
  x <- NULL
  if (!is.null(d)) { x <- list(pd = d, complete = TRUE); note_fetch(y, m, "mmsdm", "", log = "pd") }
  else {
    m0 <- as.Date(sprintf("%d-%02d-01", y, m))
    if (m0 < seq(today, by = "-4 months", length.out = 2)[2]) { note_fetch(y, m, "FAILED", err, log = "pd"); return(NULL) }
    d <- tryCatch(fetch_pd_weekly(y, m, tmp, cache_dir), error = function(e) { err <<- paste(err, "|", conditionMessage(e)); NULL })
    if (is.null(d)) { note_fetch(y, m, "FAILED", err, log = "pd"); return(NULL) }
    x <- list(pd = d, complete = FALSE); note_fetch(y, m, "weekly", "not in MMSDM yet; built from the weekly PredispatchIS archive", log = "pd")
  }
  dir.create(dirname(f), recursive = TRUE, showWarnings = FALSE); saveRDS(x, f)
  x
}

# ---------- synthetic PD (demo build): forecasts of the synthetic actuals with lead-dependent error ----------
SYN_DEMAND <- c(NSW1 = 8200, QLD1 = 6600, VIC1 = 5400, SA1 = 1500, TAS1 = 1150)
synth_pd_month <- function(y, m, nem_dir, units, cache_dir) {
  f <- file.path(cache_dir, "pd", sprintf("%d%02d.rds", y, m))
  m0 <- as.Date(sprintf("%d-%02d-01", y, m)); m1 <- seq(m0, by = "month", length.out = 2)[2] - 1
  keys <- unique(format(c(m0, m1 + 1), "%Y%m")); mf <- file.path(nem_dir, paste0(keys, ".rds")); mf <- mf[file.exists(mf)]
  if (!length(mf)) return(NULL)
  mm <- lapply(mf, readRDS)
  set.seed(y * 100 + m)
  half <- function(t) ceiling(t / 1800) * 1800
  pr <- rbindlist(lapply(mm, `[[`, "price"), use.names = TRUE)[, .(act = mean(rrp)), by = .(region, t = half(t))]
  sc <- rbindlist(lapply(mm, `[[`, "scada"), use.names = TRUE)
  sc[, region := units$region[match(duid, units$duid)]]
  re <- sc[!is.na(region), .(so = sum(pmax(so, 0))), by = .(region, t5 = t)][, .(re = mean(so)), by = .(region, t = half(t5))]
  A <- merge(pr, re, by = c("region", "t"), all.x = TRUE)[!is.na(re)]
  lt <- as.POSIXlt(A$t + NEM_OFF - 1800, origin = "1970-01-01", tz = "UTC")
  hod <- lt$hour + lt$min / 60; doy <- lt$yday + 1; win <- cos(2 * pi * (doy - 196) / 365)
  A[, dem := SYN_DEMAND[region] * (0.78 + 0.16 * exp(-((hod - 18.3)^2) / 4) + 0.08 * exp(-((hod - 8)^2) / 3) + 0.07 * win - 0.05 * (lt$wday %in% c(0, 6))) * exp(rnorm(.N, 0, 0.012))]
  A[, `:=`(rd = dem - re)]
  out <- list()
  for (r in unique(A$region)) {
    a <- A[region == r][order(t)]
    fit <- stats::lm(pmin(pmax(act, -100), 300) ~ rd, data = a)
    for (d in as.list(seq(m0, m1, by = "day"))) {
      lo <- day0(d); idx <- which(a$t > lo & a$t <= lo + SHP_NP * 1800); if (!length(idx)) next
      for (h in SHP_RUNS) {
        run <- day0(d - 1) + h * 3600
        hz <- if (h < 12.5) day0(d) + 4 * 3600 else day0(d + 1) + 4 * 3600        # PD horizon: end of trading day D-1 or D
        k <- idx[a$t[idx] <= hz]; if (!length(k)) next
        lead <- (a$t[k] - run) / 3600
        e <- as.numeric(stats::filter(rnorm(length(k)), 0.85, method = "recursive")) * 0.5
        rdf <- a$rd[k] + SYN_DEMAND[r] * (0.02 + 0.0045 * lead) * e
        pdp <- predict(fit, data.frame(rd = rdf)) + rnorm(length(k), 0, 9)
        sp <- a$act[k] > 600 & runif(length(k)) < 0.35; pdp[sp] <- a$act[k][sp] * runif(sum(sp), 0.3, 1)
        out[[length(out) + 1]] <- data.table(run = run, t = a$t[k], region = r, rrp = round(pdp, 2), dem = round(a$dem[k] + rdf - a$rd[k], 1),
                                             sol = 0, wnd = round(a$re[k], 1))
      }
    }
  }
  x <- list(pd = rbindlist(out), complete = TRUE)
  dir.create(dirname(f), recursive = TRUE, showWarnings = FALSE); saveRDS(x, f)
  x
}

# ---------- build: one WDB1 file per region and year ----------
#   pdp, rd : float32 [day][run][period]  (13 runs x 56 half-hours)      act : float32 [day][period]
build_shaping_year <- function(y, pd_months, nem_months, out_dir, data_end) {
  d0 <- as.Date(sprintf("%d-01-01", y)); dl <- as.Date(as.POSIXct(data_end + NEM_OFF - 1, origin = "1970-01-01", tz = "UTC"))
  dN <- min(as.Date(sprintf("%d-12-31", y)), dl - 1)   # the last day needs its full 56 half-hours of actuals
  if (dN < d0) return(NULL)
  days <- seq(d0, dN, by = "day"); nd <- length(days); base <- day0(d0)
  pd <- rbindlist(lapply(pd_months, `[[`, "pd"), use.names = TRUE)
  pr <- rbindlist(lapply(nem_months, `[[`, "price"), use.names = TRUE)
  act <- pr[, .(n = .N, act = mean(rrp)), by = .(region, t = ceiling(t / 1800) * 1800)][n >= 4]
  nr <- length(SHP_RUNS); files <- list()
  # map a half-hour ending t to (day, period): (D 00:00, D+1 00:00] is periods 0-47 of D; (D+1 00:00, D+1 04:00] is
  # also periods 48-55 of D (the tail of trading day D)
  slots <- function(t) {
    dA <- floor((t - 1 - base) / 86400); pA <- (t - base - dA * 86400) / 1800 - 1
    i2 <- which(pA < 8)
    data.table(row = c(seq_along(t), i2), di = c(dA, dA[i2] - 1), pi = c(pA, pA[i2] + 48))
  }
  for (r in sort(unique(c(pd$region, act$region)))) {
    P <- rep(NA_real_, nd * nr * SHP_NP); Rd <- P; A <- rep(NA_real_, nd * SHP_NP)
    x <- pd[region == r]
    if (nrow(x)) {
      sl <- slots(x$t); sl[, ri := (x$run[row] - (base + (di - 1) * 86400)) / 3600 - SHP_RUNS[1]]
      sl <- sl[di >= 0 & di < nd & pi >= 0 & pi < SHP_NP & abs(ri - round(ri)) < 1e-6 & ri >= 0 & ri < nr]
      k <- (sl$di * nr + round(sl$ri)) * SHP_NP + sl$pi + 1
      P[k] <- x$rrp[sl$row]; Rd[k] <- (x$dem - x$sol - x$wnd)[sl$row]
    }
    a <- act[region == r]
    if (nrow(a)) {
      sl <- slots(a$t)[di >= 0 & di < nd & pi >= 0 & pi < SHP_NP]
      A[sl$di * SHP_NP + sl$pi + 1] <- a$act[sl$row]
    }
    fn <- sprintf("shp/%s_%d.bin", r, y)
    ri16 <- which(SHP_RUNS == 16) - 1
    ok16 <- vapply(seq_len(nd) - 1, function(d) sum(!is.na(Rd[(d * nr + ri16) * SHP_NP + 1:48])) == 48, TRUE)
    sz <- write_wdb(file.path(out_dir, fn), list(region = r, year = y, d0 = format(d0), nd = nd, runs = I(SHP_RUNS), np = SHP_NP),
                    list(enc_f32(P), enc_f32(Rd), enc_f32(A)),
                    list(list(id = "pdp", enc = "f32"), list(id = "rd", enc = "f32"), list(id = "act", enc = "f32")))
    files[[r]] <- list(file = fn, bytes = sz, nd = nd, rd16 = sum(ok16), act = sum(!is.na(A)) / SHP_NP)
  }
  list(year = y, files = files)
}

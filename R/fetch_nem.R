# NEM source data from NEMWeb.
#   Complete months : MMSDM monthly archive (DISPATCH_UNIT_SCADA, DISPATCHLOAD, DISPATCHPRICE, TRADINGPRICE and the
#                     registration tables)
#   Recent days     : Reports/Archive/Dispatch_SCADA (daily, nested zips), Reports/Current/Next_Day_Dispatch,
#                     Reports/Current/Public_Prices, until MMSDM publishes the month (2-6 weeks after month end).
# Big tables are filtered in the shell (grep for the wanted DUIDs, cut to the wanted columns) before R reads them.

NEMWEB  <- "https://nemweb.com.au"
MMSDM   <- paste0(NEMWEB, "/Data_Archive/Wholesale_Electricity/MMSDM")
NEM_OFF <- 10 * 3600                                                             # market time = UTC+10, no DST
CUT_5MS <- as.numeric(as.POSIXct("2021-10-01 04:05", tz = "UTC")) - NEM_OFF       # first 5-min settled interval
UA      <- "wind-index-dashboard/2.0 (GitHub Actions; contact via repo issues)"
DISP_COLS <- c("INITIALMW", "TOTALCLEARED", "AVAILABILITY", "UIGF")              # UIGF is absent from older files

log_msg <- function(...) cat(format(Sys.time(), "%H:%M:%S"), sprintf(...), "\n")

# ---------- HTTP ----------
list_dir <- function(url) {
  x <- tryCatch(suppressWarnings(readLines(url, warn = FALSE)), error = function(e) character())
  if (!length(x)) return(character())
  h <- unlist(regmatches(x, gregexpr('(?i)href="[^"]+"', x, perl = TRUE)))
  h <- sub('(?i)^href="', "", sub('"$', "", h), perl = TRUE)
  basename(utils::URLdecode(h))
}
enc_name <- function(f) gsub("#", "%23", f, fixed = TRUE)
download <- function(url, dest) {
  dir.create(dirname(dest), recursive = TRUE, showWarnings = FALSE)
  rc <- system2("curl", c("-fsSL", "--retry", "5", "--retry-delay", "20", "--retry-all-errors",
                          "-A", shQuote(UA), "-o", shQuote(dest), shQuote(url)))
  Sys.sleep(0.5)
  if (rc != 0 || !file.exists(dest)) { unlink(dest); stop("download failed: ", url) }
  dest
}

# ---------- AEMO CSV reader ----------
# table: record prefix after "I,"/"D,", e.g. "DISPATCH,UNIT_SCADA,". keep: required columns; opt: optional columns
# (returned as NA when the file predates them). duids: optional whole-field filter.
read_aemo <- function(zip, table, keep, duids = NULL, nested = FALSE, opt = character()) {
  cat_cmd <- if (nested) {
    sprintf("d=$(mktemp -d); unzip -q -o %s -d \"$d\"; for f in \"$d\"/*.zip; do unzip -p \"$f\"; done; rm -rf \"$d\"", shQuote(zip))
  } else sprintf("unzip -p %s", shQuote(zip))
  hdr <- suppressWarnings(system(sprintf("{ %s; } | grep -m1 -F %s", cat_cmd, shQuote(paste0("I,", table))), intern = TRUE))
  if (!length(hdr)) return(NULL)
  cols <- strsplit(hdr[1], ",", fixed = TRUE)[[1]]
  idx <- match(keep, cols)
  if (anyNA(idx)) stop(sprintf("%s: columns not found in %s: %s", basename(zip), table, paste(keep[is.na(idx)], collapse = ",")))
  oi <- match(opt, cols); have <- c(keep, opt[!is.na(oi)]); hidx <- c(idx, oi[!is.na(oi)])
  filt <- ""
  if (!is.null(duids)) {
    pat <- tempfile(fileext = ".txt")
    writeLines(c(paste0(",", duids, ","), paste0(",\"", duids, "\",")), pat)
    filt <- sprintf("| grep -F -f %s", shQuote(pat))
  }
  cmd <- sprintf("{ %s; } | grep -F %s %s | cut -d, -f%s", cat_cmd, shQuote(paste0("D,", table)), filt, paste(sort(hidx), collapse = ","))
  out <- tryCatch(fread(cmd = cmd, header = FALSE, sep = ",", quote = "\"", colClasses = "character", showProgress = FALSE),
                  error = function(e) data.table())
  if (!nrow(out)) return(NULL)
  setnames(out, have[order(hidx)])
  for (o in setdiff(opt, have)) set(out, j = o, value = NA_character_)
  setcolorder(out, c(keep, opt))
  if (!is.null(duids) && "DUID" %in% names(out)) out <- out[gsub("\"", "", DUID) %chin% duids]
  out[]
}
aemo_time <- function(x) as.numeric(as.POSIXct(gsub("\"", "", x), format = "%Y/%m/%d %H:%M:%S", tz = "UTC")) - NEM_OFF
aemo_date <- function(x) as.Date(substr(gsub("\"", "", x), 1, 10), "%Y/%m/%d")
num <- function(x) suppressWarnings(as.numeric(gsub("\"", "", x)))
chr <- function(x) gsub("\"", "", x)

# ---------- shaping ----------
shape_scada <- function(d) if (is.null(d)) NULL else unique(d[, .(t = aemo_time(SETTLEMENTDATE), duid = chr(DUID), so = num(SCADAVALUE))], by = c("t", "duid"))
shape_disp <- function(d) {
  if (is.null(d)) return(NULL)
  unique(d[num(INTERVENTION) == 0, .(t = aemo_time(SETTLEMENTDATE), duid = chr(DUID), initialmw = num(INITIALMW),
                                     cleared = num(TOTALCLEARED), avail = num(AVAILABILITY), uigf = num(UIGF))], by = c("t", "duid"))
}
shape_price <- function(d) if (is.null(d)) NULL else unique(d[num(INTERVENTION) == 0, .(t = aemo_time(SETTLEMENTDATE), region = chr(REGIONID), rrp = num(RRP))], by = c("t", "region"))
expand_30 <- function(p) p[, .(t = t - c(25, 20, 15, 10, 5, 0) * 60, rrp = rrp), by = .(tt = t, region)][, tt := NULL][]
disp_keep <- c("SETTLEMENTDATE", "DUID", "INTERVENTION", "INITIALMW", "TOTALCLEARED", "AVAILABILITY")

# ---------- MMSDM ----------
mmsdm_files <- function(y, m) {
  url <- sprintf("%s/%d/MMSDM_%d_%02d/MMSDM_Historical_Data_SQLLoader/DATA/", MMSDM, y, y, m)
  f <- list_dir(url); f <- f[grepl("\\.zip$", f, ignore.case = TRUE)]
  list(url = url, files = f)
}
pick <- function(files, table) files[grepl(sprintf("(PUBLIC_DVD_|PUBLIC_ARCHIVE#)%s(_|#FILE[0-9]+#)[0-9]{12}\\.zip$", table), files)]
mm_get <- function(L, tmp, table, rec, keep, duids = NULL, opt = character()) {
  rbindlist(lapply(pick(L$files, table), function(f) {
    z <- download(paste0(L$url, enc_name(f)), file.path(tmp, f)); on.exit(unlink(z))
    read_aemo(z, rec, keep, duids, opt = opt)
  }), fill = TRUE)
}

# registration tables for one MMSDM month (small; fetched for every month so the union covers all DUIDs ever registered)
REG_TABLES <- list(
  DUDETAIL        = list(rec = "PARTICIPANT_REGISTRATION,DUDETAIL,", keep = c("EFFECTIVEDATE", "DUID", "VERSIONNO", "REGISTEREDCAPACITY", "MAXCAPACITY", "DISPATCHTYPE")),
  DUDETAILSUMMARY = list(rec = "PARTICIPANT_REGISTRATION,DUDETAILSUMMARY,", keep = c("DUID", "START_DATE", "END_DATE", "DISPATCHTYPE", "REGIONID", "STATIONID", "SCHEDULE_TYPE", "TRANSMISSIONLOSSFACTOR", "DISTRIBUTIONLOSSFACTOR")),
  GENUNITS        = list(rec = "PARTICIPANT_REGISTRATION,GENUNITS,", keep = c("GENSETID", "REGISTEREDCAPACITY", "MAXCAPACITY", "CO2E_ENERGY_SOURCE")),
  DUALLOC         = list(rec = "PARTICIPANT_REGISTRATION,DUALLOC,", keep = c("EFFECTIVEDATE", "VERSIONNO", "DUID", "GENSETID")),
  STATION         = list(rec = "PARTICIPANT_REGISTRATION,STATION,", keep = c("STATIONID", "STATIONNAME")))

fetch_registry_month <- function(y, m, cache_dir) {
  f <- file.path(cache_dir, "registry", sprintf("%d%02d.rds", y, m))
  if (file.exists(f)) return(readRDS(f))
  L <- mmsdm_files(y, m)
  if (!length(pick(L$files, "DUDETAILSUMMARY"))) return(NULL)
  tmp <- tempfile("reg"); dir.create(tmp); on.exit(unlink(tmp, recursive = TRUE))
  log_msg("registry %d-%02d", y, m)
  x <- lapply(names(REG_TABLES), function(k) { s <- REG_TABLES[[k]]; tryCatch(mm_get(L, tmp, k, s$rec, s$keep), error = function(e) NULL) })
  names(x) <- names(REG_TABLES)
  dir.create(dirname(f), recursive = TRUE, showWarnings = FALSE); saveRDS(x, f)
  x
}

fetch_mmsdm_month <- function(y, m, duids, tmp) {
  L <- mmsdm_files(y, m)
  if (!length(L$files)) stop("MMSDM folder listing empty or unreachable: ", L$url)
  if (!length(pick(L$files, "DISPATCH_UNIT_SCADA"))) stop("no DISPATCH_UNIT_SCADA file in ", L$url)
  log_msg("MMSDM %d-%02d (%d DUIDs)", y, m, length(duids))
  scada <- shape_scada(mm_get(L, tmp, "DISPATCH_UNIT_SCADA", "DISPATCH,UNIT_SCADA,", c("SETTLEMENTDATE", "DUID", "SCADAVALUE"), duids))
  disp  <- shape_disp(mm_get(L, tmp, "DISPATCHLOAD", "DISPATCH,UNIT_SOLUTION,", disp_keep, duids, opt = "UIGF"))
  dp    <- shape_price(mm_get(L, tmp, "DISPATCHPRICE", "DISPATCH,PRICE,", c("SETTLEMENTDATE", "REGIONID", "INTERVENTION", "RRP")))
  price <- dp[t >= CUT_5MS]
  if (any(dp$t < CUT_5MS)) {   # before 5MS, settlement used the 30-min trading price
    tp <- mm_get(L, tmp, "TRADINGPRICE", "TRADING,PRICE,", c("SETTLEMENTDATE", "REGIONID", "RRP"))
    tp <- unique(tp[, .(t = aemo_time(SETTLEMENTDATE), region = chr(REGIONID), rrp = num(RRP))], by = c("t", "region"))
    price <- rbind(expand_30(tp)[t < CUT_5MS], price)
  }
  for (k in c("scada", "disp", "price")) if (!NROW(get(k))) stop("MMSDM ", k, " table read as empty")
  list(scada = scada, disp = disp, price = price, complete = TRUE)
}

# ---------- daily reports (months not yet in MMSDM) ----------
day_files <- local({ memo <- new.env(); function(dir) { if (is.null(memo[[dir]])) memo[[dir]] <- list_dir(paste0(NEMWEB, dir)); memo[[dir]] } })
fetch_day <- function(d, duids, tmp, cache_dir) {
  out <- file.path(cache_dir, "daily", paste0(format(d, "%Y%m%d"), ".rds"))
  if (file.exists(out)) { x <- readRDS(out); if (all(duids %chin% x$duids)) return(x) }
  ymd <- format(d, "%Y%m%d")
  find <- function(dir, re) { f <- grep(re, day_files(dir), value = TRUE); if (length(f)) paste0(NEMWEB, dir, tail(sort(f), 1)) else NA }
  u_sc <- find("/Reports/Archive/Dispatch_SCADA/", sprintf("^PUBLIC_DISPATCHSCADA_%s\\.zip$", ymd))
  u_dl <- find("/Reports/Current/Next_Day_Dispatch/", sprintf("^PUBLIC_NEXT_DAY_DISPATCH_%s_.*\\.zip$", ymd))
  u_pr <- find("/Reports/Current/Public_Prices/", sprintf("^PUBLIC_PRICES_%s0000_.*\\.zip$", ymd))
  if (anyNA(c(u_sc, u_dl, u_pr))) return(NULL)
  log_msg("daily %s", ymd)
  g <- function(u, ...) { z <- download(u, file.path(tmp, basename(u))); on.exit(unlink(z)); read_aemo(z, ...) }
  res <- list(scada = shape_scada(g(u_sc, "DISPATCH,UNIT_SCADA,", c("SETTLEMENTDATE", "DUID", "SCADAVALUE"), duids, nested = TRUE)),
              disp  = shape_disp(g(u_dl, "DISPATCH,UNIT_SOLUTION,", disp_keep, duids, opt = "UIGF")),
              price = shape_price(g(u_pr, "DREGION,", c("SETTLEMENTDATE", "REGIONID", "INTERVENTION", "RRP"))),
              duids = duids)
  dir.create(dirname(out), recursive = TRUE, showWarnings = FALSE); saveRDS(res, out)
  res
}

# ---------- month entry point ----------
# Returns list(scada, disp, price, complete, duids). MMSDM months are kept for good unless the DUID list grows;
# daily-built months are rebuilt each run from cached days until MMSDM publishes the month.
# Each call records an outcome in FETCH_LOG (month, source, note), printed and saved by run.R.
FETCH_LOG <- new.env()
note_fetch <- function(y, m, src, msg = "") assign(sprintf("%d-%02d", y, m), list(src = src, msg = msg), envir = FETCH_LOG)
fetch_nem_month <- function(y, m, duids, cache_dir, today = Sys.Date()) {
  f <- file.path(cache_dir, sprintf("%d%02d.rds", y, m))
  if (file.exists(f)) { x <- readRDS(f); if (isTRUE(x$complete) && all(duids %chin% x$duids)) { note_fetch(y, m, "cached"); return(x) } }
  tmp <- tempfile("nem"); dir.create(tmp); on.exit(unlink(tmp, recursive = TRUE))
  err <- ""
  x <- tryCatch(fetch_mmsdm_month(y, m, duids, tmp), error = function(e) { err <<- conditionMessage(e); log_msg("MMSDM %d-%02d failed: %s", y, m, err); NULL })
  if (!is.null(x)) note_fetch(y, m, "mmsdm")
  if (is.null(x)) {
    m0 <- as.Date(sprintf("%d-%02d-01", y, m)); m1 <- seq(m0, by = "month", length.out = 2)[2] - 1
    if (m0 > today - 1) return(NULL)
    if (m0 < seq(today, by = "-4 months", length.out = 2)[2]) {   # daily reports only cover recent months
      note_fetch(y, m, "FAILED", err); return(NULL)
    }
    days <- seq(m0 - 1, min(m1 + 1, today - 1), by = "day")
    parts <- lapply(days, function(d) tryCatch(fetch_day(d, duids, tmp, cache_dir), error = function(e) { log_msg("day %s failed: %s", d, conditionMessage(e)); NULL }))
    parts <- Filter(Negate(is.null), parts)
    if (!length(parts)) { note_fetch(y, m, "FAILED", paste(err, "| no daily reports")); return(NULL) }
    lo <- as.numeric(as.POSIXct(m0, tz = "UTC")) - NEM_OFF; hi <- as.numeric(as.POSIXct(m1 + 1, tz = "UTC")) - NEM_OFF
    cut <- function(k, by) { d <- rbindlist(lapply(parts, `[[`, k)); unique(d[t > lo & t <= hi], by = by) }
    x <- list(scada = cut("scada", c("t", "duid")), disp = cut("disp", c("t", "duid")), price = cut("price", c("t", "region")), complete = FALSE)
    note_fetch(y, m, "daily", err)
  }
  x$duids <- duids
  dir.create(cache_dir, recursive = TRUE, showWarnings = FALSE); saveRDS(x, f)
  x
}

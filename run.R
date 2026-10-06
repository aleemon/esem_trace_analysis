#!/usr/bin/env Rscript
# Nightly build: register -> fetch months -> first generation dates -> rebuild changed years -> assemble site/data.
# Environment:
#   DATA_SOURCE  "aemo" (NEMWeb) or "synthetic" (generated demo data; default)
#   START_YEAR   first reporting year (default 2018 for aemo); YEARS_BACK is used when START_YEAR is unset
#   YEARS_BACK   reporting years, ending with the current year (default 5). History is fetched from one year
#                earlier so first-generation dates (6-month basket rule) are known for the first reporting year.
#   FORCE        "true" rebuilds every year
#   SHAPE_START_YEAR first year of the shaping-contract tab (default 2021 for aemo; predispatch UIGF is needed for
#                residual demand). Predispatch history is fetched from the December before.
#   FETCH_MINUTES stop starting new month downloads after this many minutes (default 210), so a long backfill ends
#                cleanly inside the job limit, saves what it has, and the next run carries on
#   CACHE_DIR    default "cache"; SITE_DATA default "site/data"
suppressPackageStartupMessages({ library(data.table); library(jsonlite) })
for (f in c("R/wdb.R", "R/fetch_nem.R", "R/registry.R", "R/build.R", "R/synthetic.R", "R/shaping.R")) source(f)

env <- function(k, d) { v <- Sys.getenv(k, ""); if (nzchar(v)) v else d }
SOURCE <- tolower(env("DATA_SOURCE", "synthetic")); stopifnot(SOURCE %in% c("aemo", "synthetic"))
YEARS_BACK <- as.integer(env("YEARS_BACK", "5")); FORCE <- tolower(env("FORCE", "false")) == "true"
CACHE <- env("CACHE_DIR", "cache"); SITE <- env("SITE_DATA", "site/data")
NEMC <- file.path(CACHE, "nem"); OUT <- file.path(CACHE, "out"); DER <- file.path(CACHE, "derived")
today <- as.Date(format(Sys.time(), tz = "Australia/Brisbane"))
START_YEAR <- env("START_YEAR", if (SOURCE == "aemo") "2018" else "")   # AEMO default: report from 2018
y_now <- as.integer(format(today, "%Y"))
years <- if (nzchar(START_YEAR)) as.integer(START_YEAR):y_now else (y_now - YEARS_BACK + 1L):y_now
fetch_from <- as.Date(sprintf("%d-01-01", min(years) - 1L))
months <- CJ(y = (min(years) - 1L):max(years), m = 1:12)[as.Date(sprintf("%d-%02d-01", y, m)) <= today - 1]
mkey <- function(y, m) sprintf("%d%02d", y, m)
md5 <- function(x) { f <- tempfile(); saveRDS(x, f, compress = FALSE); on.exit(unlink(f)); unname(tools::md5sum(f)) }
log_msg("source %s, reporting years %d-%d, history from %s", SOURCE, min(years), max(years), fetch_from)
budget <- Sys.time() + 60 * as.numeric(env("FETCH_MINUTES", "210"))
SHAPE_START <- as.integer(env("SHAPE_START_YEAR", if (SOURCE == "aemo") "2021" else as.character(min(years))))
shp_years <- years[years >= SHAPE_START]
PDC <- file.path(CACHE, "pd")

# ---- register + month data ----
if (SOURCE == "synthetic") {
  sig <- md5(list(fetch_from, today, SYN_REGIONS, readLines("R/synthetic.R")))
  sf <- file.path(CACHE, "synthetic_register.rds")
  if (FORCE || !file.exists(sf) || !identical(readRDS(sf)$sig, sig)) {
    unlink(NEMC, recursive = TRUE); dir.create(NEMC, recursive = TRUE)
    reg <- synth_build(NEMC, fetch_from, today - 1); reg$sig <- sig; saveRDS(reg, sf)
  } else reg <- readRDS(sf)
} else {
  regm <- list()
  for (i in seq_len(nrow(months))) {
    x <- tryCatch(fetch_registry_month(months$y[i], months$m[i], CACHE), error = function(e) NULL)
    if (!is.null(x)) regm[[mkey(months$y[i], months$m[i])]] <- x
  }
  if (!length(regm)) stop("no MMSDM registration tables could be fetched")
  reg <- build_registry(regm)
  for (i in seq_len(nrow(months))) {
    k <- mkey(months$y[i], months$m[i]); f <- file.path(NEMC, paste0(k, ".rds"))
    if (Sys.time() > budget && !file.exists(f)) { note_fetch(months$y[i], months$m[i], "DEFERRED", "time budget reached; next run continues"); next }
    fetch_nem_month(months$y[i], months$m[i], reg$units$duid, NEMC, today)
  }
}

# ---- shaping contract: predispatch at the nomination runs (fetched, or generated for the demo) ----
pmonths <- if (length(shp_years)) CJ(y = (min(shp_years) - 1L):max(shp_years), m = 1:12)[as.Date(sprintf("%d-%02d-01", y, m)) <= today - 1 & !(y < min(shp_years) & m < 12)] else data.table(y = integer(), m = integer())
for (i in seq_len(nrow(pmonths))) {
  yy <- pmonths$y[i]; mo <- pmonths$m[i]; f <- file.path(PDC, sprintf("%d%02d.rds", yy, mo))
  if (SOURCE == "synthetic") {
    src <- file.path(NEMC, sprintf("%d%02d.rds", yy, mo))
    if (file.exists(src) && (!file.exists(f) || file.mtime(f) < file.mtime(src))) { log_msg("synthetic PD %d-%02d", yy, mo); synth_pd_month(yy, mo, NEMC, reg$units, CACHE) }
    next
  }
  if (Sys.time() > budget && !file.exists(f)) { note_fetch(yy, mo, "DEFERRED", "time budget reached; next run continues", log = "pd"); next }
  fetch_pd_month(yy, mo, CACHE, today)
}
if (SOURCE == "aemo") {
  # month-by-month fetch report: printed to the log and saved for the data release
  fr <- rbindlist(lapply(sort(ls(FETCH_LOG)), function(k) c(month = k, FETCH_LOG[[k]])))
  if (nrow(fr)) {
    log_msg("fetch report: %s", paste(sprintf("%s %d", names(table(fr$src)), as.integer(table(fr$src))), collapse = ", "))
    bad <- fr[src %in% c("FAILED", "DEFERRED")]
    if (nrow(bad)) for (j in seq_len(nrow(bad))) log_msg("  %s %s %s", bad$month[j], bad$src[j], bad$msg[j])
    dir.create(OUT, recursive = TRUE, showWarnings = FALSE)
    writeLines(c("| month | source | note |", "| --- | --- | --- |", sprintf("| %s | %s | %s |", fr$month, fr$src, gsub("|", "/", fr$msg, fixed = TRUE))),
             file.path(OUT, "fetch_report.md"))
  }
}
units <- copy(reg$units); caph <- reg$caph
saveRDS(list(units = reg$units, caph = reg$caph, source = SOURCE), file.path(CACHE, "register.rds"))   # for tests/benchmark.R
log_msg("register: %d wind, %d solar units", sum(units$tech == "wind"), sum(units$tech == "solar"))

# ---- month summaries: coverage, first generation, data end ----
summ <- list()
for (i in seq_len(nrow(months))) {
  k <- mkey(months$y[i], months$m[i]); f <- file.path(NEMC, paste0(k, ".rds"))
  if (!file.exists(f)) next
  sf <- file.path(NEMC, "summary", paste0(k, ".rds")); mt <- file.mtime(f)
  if (file.exists(sf) && identical(readRDS(sf)$mtime, mt)) { summ[[k]] <- readRDS(sf); next }
  x <- readRDS(f)
  s <- list(mtime = mt, tmax = c(scada = max(c(-Inf, x$scada$t)), disp = max(c(-Inf, x$disp$t)), price = max(c(-Inf, x$price$t))),
            tmin = min(c(Inf, x$price$t)), first = x$scada[so >= 1, .(t = min(t)), by = duid])
  dir.create(dirname(sf), recursive = TRUE, showWarnings = FALSE); saveRDS(s, sf); summ[[k]] <- s
  rm(x); gc(verbose = FALSE)
}
if (!length(summ)) stop("no month data available")
data_end <- min(apply(do.call(rbind, lapply(summ, `[[`, "tmax")), 2, max))
hist_start <- min(vapply(summ, `[[`, 0, "tmin"))
fg <- rbindlist(lapply(summ, `[[`, "first"))[, .(t = min(t)), by = duid]
units[, first_gen := as.Date(as.POSIXct(fg$t[match(duid, fg$duid)] + NEM_OFF - DT_SEC, origin = "1970-01-01", tz = "UTC"))]
# generating from the start of the fetched history: the real start is earlier, so use the registration date
units[, first_op := fifelse(!is.na(first_gen) & first_gen <= as.Date(as.POSIXct(hist_start + NEM_OFF, origin = "1970-01-01", tz = "UTC")) + 7,
                            fifelse(is.na(reg_date), first_gen, pmin(reg_date, first_gen)), first_gen)]
units[, `:=`(block = (seq_len(.N) - 1L) %/% BLOCK, slot = (seq_len(.N) - 1L) %% BLOCK), by = region]
units[, gi := seq_len(.N) - 1L]
log_msg("data end %s (market time)", format(as.POSIXct(data_end + NEM_OFF, origin = "1970-01-01", tz = "UTC"), "%Y-%m-%d %H:%M"))

# ---- years ----
derived <- list()
for (y in years) {
  keys <- c(mkey(y, 1:12), mkey(y + 1L, 1L)); keys <- keys[keys %in% names(summ)]
  if (!length(keys)) next
  sig <- md5(list(units[, .(duid, region, tech, cap, reg_date, first_op, end_date, block)], caph, lapply(summ[keys], `[[`, "mtime"),
                  data_end = if (y == max(years)) data_end else NULL, code = readLines("R/build.R")))
  dfile <- file.path(DER, paste0(y, ".rds"))
  if (!FORCE && file.exists(dfile)) { d <- readRDS(dfile); if (identical(d$sig, sig)) { derived[[length(derived) + 1]] <- d; next } }
  log_msg("build %d", y)
  mm <- lapply(keys, function(k) readRDS(file.path(NEMC, paste0(k, ".rds"))))
  d <- build_year(y, mm, units, caph, OUT, data_end)
  rm(mm); gc(verbose = FALSE)
  if (is.null(d)) next
  d$sig <- sig; dir.create(DER, recursive = TRUE, showWarnings = FALSE); saveRDS(d, dfile)
  derived[[length(derived) + 1]] <- d
}
if (!length(derived)) stop("nothing built")

# ---- shaping contract files ----
shp <- list()
for (y in shp_years) {
  pk <- c(mkey(y - 1L, 12L), mkey(y, 1:12), mkey(y + 1L, 1L)); pf <- file.path(PDC, paste0(pk, ".rds")); pf <- pf[file.exists(pf)]
  nk <- c(mkey(y, 1:12), mkey(y + 1L, 1L)); nf <- file.path(NEMC, paste0(nk, ".rds")); nf <- nf[file.exists(nf)]
  if (!length(pf) || !length(nf)) next
  sig <- md5(list(file.mtime(pf), file.mtime(nf), data_end = if (y == max(years)) data_end else NULL, code = readLines("R/shaping.R")))
  dfile <- file.path(DER, sprintf("shp_%d.rds", y))
  if (!FORCE && file.exists(dfile)) { d <- readRDS(dfile); if (identical(d$sig, sig) && all(file.exists(file.path(OUT, vapply(d$files, `[[`, "", "file"))))) { shp[[length(shp) + 1]] <- d; next } }
  log_msg("build shaping %d", y)
  d <- build_shaping_year(y, lapply(pf, readRDS), lapply(nf, readRDS), OUT, data_end)
  gc(verbose = FALSE)
  if (is.null(d)) next
  d$sig <- sig; dir.create(DER, recursive = TRUE, showWarnings = FALSE); saveRDS(d, dfile)
  shp[[length(shp) + 1]] <- d
}
shp_meta <- if (length(shp)) list(runs = I(SHP_RUNS), np = SHP_NP, years = I(vapply(shp, `[[`, 0, "year")),
  regions = I(sort(unique(unlist(lapply(shp, function(d) names(d$files)))))),
  files = setNames(lapply(shp, function(d) lapply(d$files, function(f) list(file = f$file, bytes = f$bytes, nd = f$nd, rd16 = f$rd16))), vapply(shp, function(d) as.character(d$year), ""))) else NULL

# ---- assemble + copy ----
n_weeks <- as.integer(ceiling((as.numeric(as.POSIXct(sprintf("%d-01-08", max(years) + 1), tz = "UTC")) - REF_SUN) / 604800))
assemble(units, derived, OUT, n_weeks,
         list(source = SOURCE, generated = format(Sys.time(), "%Y-%m-%d %H:%M %Z", tz = "Australia/Sydney"),
              data_end = format(as.POSIXct(data_end + NEM_OFF, origin = "1970-01-01", tz = "UTC"), "%Y-%m-%d %H:%M"), shaping = shp_meta), caph_all = caph)
unlink(SITE, recursive = TRUE); dir.create(SITE, recursive = TRUE)
keep <- c("meta.json", "settle.bin", if (file.exists(file.path(OUT, "baskets.csv"))) "baskets.csv", unlist(lapply(derived, function(d) c(vapply(d$files$idx, `[[`, "", "file"), vapply(d$files$unit, `[[`, "", "file")))),
          unlist(lapply(shp, function(d) vapply(d$files, `[[`, "", "file"))))
for (f in keep) { dir.create(dirname(file.path(SITE, f)), recursive = TRUE, showWarnings = FALSE); file.copy(file.path(OUT, f), file.path(SITE, f), overwrite = TRUE) }
log_msg("site/data: %d files, %.1f MB", length(keep), sum(file.size(file.path(SITE, keep))) / 1e6)

# Synthetic NEM wind and solar data in the same shape the AEMO fetchers produce, for the demo build and tests.
# Writes cache/nem/YYYYMM.rds month objects (scada, disp, price) and returns the unit register.
# Nothing here is a market record: DUIDs, stations, capacities, outputs and prices are all generated.

SYN_REGIONS <- data.table(region = c("NSW1", "QLD1", "VIC1", "SA1", "TAS1"),
                          n_wind = c(18L, 8L, 28L, 18L, 6L), n_solar = c(24L, 24L, 14L, 8L, 0L),
                          noon = c(12.0, 11.9, 12.4, 12.9, 12.4), base = c(105, 95, 90, 100, 85),
                          solar_pen = c(1.1, 1.3, 1.0, 1.4, 0.3), wind_pen = c(0.7, 0.5, 1.1, 1.3, 0.9))

ar1 <- function(n, tau, sd) { a <- exp(-1 / tau); as.numeric(stats::filter(rnorm(n, 0, sd * sqrt(1 - a^2)), a, method = "recursive")) }

synth_build <- function(cache_dir, start = as.Date("2021-01-01"), end = Sys.Date() - 1, seed = 7) {
  set.seed(seed)
  t0 <- as.numeric(as.POSIXct(paste(start, "00:05"), tz = "UTC")) - NEM_OFF
  tN <- as.numeric(as.POSIXct(paste(end + 1, "00:00"), tz = "UTC")) - NEM_OFF
  tt <- seq(t0, tN, by = DT_SEC); n <- length(tt)
  lt <- as.POSIXlt(tt + NEM_OFF - DT_SEC, origin = "1970-01-01", tz = "UTC")
  hod <- lt$hour + lt$min / 60; doy <- lt$yday + 1; yrf <- (lt$year + 1900 - 2021) + doy / 365
  mkey <- (lt$year + 1900L) * 100L + lt$mon + 1L
  winter <- cos(2 * pi * (doy - 196) / 365)                       # +1 mid-July
  daylen <- 12 - 2.1 * winter
  units <- list(); caph <- list(); parts <- file.path(cache_dir, "synth_parts"); dir.create(parts, recursive = TRUE, showWarnings = FALSE)
  for (i in seq_len(nrow(SYN_REGIONS))) {
    R <- SYN_REGIONS[i]; r <- R$region
    log_msg("synthetic %s: %d wind, %d solar", r, R$n_wind, R$n_solar)
    wlat <- 8.2 + 1.1 * winter + 0.5 * sin(2 * pi * (hod - 3) / 24) + ar1(n, 216, 3.1)
    clat <- ar1(n, 72, 1.0)
    clear <- pmax(0, sin(pi * (hod - (R$noon - daylen / 2)) / daylen))^1.25
    pw <- function(v) { cf <- pmin(pmax((v - 3) / (12.5 - 3), 0), 1)^2.1; cf[v > 25] <- 0; cf }
    reg_w <- pw(wlat * 0.85 + 1.2); reg_s <- clear * plogis(1.6 + 1.3 * clat) * 0.92
    # price: duck curve, merit-order effect of the regional fleet, noise, spikes; negatives grow over time
    eve <- exp(-((hod - 18.6)^2) / 3) + 0.45 * exp(-((hod - 7.4)^2) / 2)
    p <- R$base * (1 + 0.65 * eve * (1 + 0.3 * pmax(winter, 0)) - R$solar_pen * (0.75 + 0.12 * yrf) * reg_s - R$wind_pen * (reg_w - 0.3)) +
         ar1(n, 24, 24) + rnorm(n, 0, 6)
    for (k in seq_len(rpois(1, 70))) { s <- sample.int(n, 1); l <- sample(1:8, 1); p[s:min(n, s + l)] <- min(rlnorm(1, log(1200), 1.1), 17500) }
    p[p < 0] <- pmax(p[p < 0] * runif(sum(p < 0), 1.2, 3.5), -1000)
    pre <- tt < CUT_5MS; p[pre] <- ave(p[pre], (seq_len(n)[pre] - 1L) %/% 6L)   # 30-min settlement before 5MS
    price <- data.table(t = tt, region = r, rrp = round(p, 2), mk = mkey)
    for (m_ in unique(mkey)) saveRDS(price[mk == m_, .(t, region, rrp)], file.path(parts, sprintf("%d_%s_price.rds", m_, r)))
    rm(price)
    specs <- rbind(if (R$n_wind) data.table(tech = "wind", k = seq_len(R$n_wind)), if (R$n_solar) data.table(tech = "solar", k = seq_len(R$n_solar)))
    for (ch in split(seq_len(nrow(specs)), ceiling(seq_len(nrow(specs)) / 12))) {
      out_s <- list(); out_d <- list()
      for (j in ch) {
        tech <- specs$tech[j]; k <- specs$k[j]
        duid <- sprintf("SY%s%s%02d", if (tech == "wind") "W" else "S", sub("1$", "", r), k)
        cap <- round(if (tech == "wind") min(max(rlnorm(1, log(170), 0.55), 30), 650) else min(max(rlnorm(1, log(110), 0.5), 20), 400), 1)
        cf <- if (tech == "wind") { rho <- runif(1, 0.6, 0.9); pw(wlat * rho + (1 - rho) * (8.2 + ar1(n, 72, 3)) + runif(1, -1, 1.5)) }
              else { rho <- runif(1, 0.7, 0.95); clear * plogis(1.6 + 1.3 * (rho * clat + (1 - rho) * ar1(n, 36, 1))) * runif(1, 0.85, 1.0) }
        af <- pmin(1, runif(1, 0.94, 0.995) + ar1(n, 2000, 0.015)); outg <- rep(1, n)
        for (o in seq_len(rpois(1, 5))) { s <- sample.int(n, 1); outg[s:min(n, s + sample(288:1728, 1))] <- runif(1, 0, 0.5) }
        pot <- cap * cf * af * outg
        # commissioning: a quarter of units start inside the history, with a hold-point ramp
        first_i <- 1L; reg_date <- as.Date("2015-01-01") + sample(0:1800, 1)
        if (runif(1) < 0.25) {
          first_i <- sample(round(n * 0.03):round(n * 0.92), 1)
          reg_date <- as.Date(as.POSIXct(tt[first_i] + NEM_OFF, origin = "1970-01-01", tz = "UTC")) - sample(30:150, 1)
          ramp <- first_i + sample((288 * 60):(288 * 120), 1)
          pot[seq_len(first_i - 1)] <- NA; pot[first_i:min(n, ramp)] <- pmin(pot[first_i:min(n, ramp)], cap * 0.5)
        }
        uigf <- pmax(0, pot * exp(ar1(n, 6, 0.06)))
        avail <- pmin(uigf, cap * af)
        floor_bid <- sample(c(-1000, -45, -10, 0), 1, prob = c(0.25, 0.3, 0.25, 0.2))
        cleared <- ifelse(p < floor_bid, 0, avail)
        if (runif(1) < 0.35) { lim <- cap * (1 - runif(1, 0.1, 0.35)); cleared <- ifelse(reg_w > 0.55 | reg_s > 0.8, pmin(cleared, lim), cleared) }
        so <- pmin(pot, cleared) + rnorm(n, 0, 0.004 * cap)
        so[!is.na(so) & so < 0.3] <- runif(sum(!is.na(so) & so < 0.3), -0.4, 0)
        so <- round(so, 2)
        gap <- function(x) { for (g in seq_len(rpois(1, 20))) { s <- sample.int(n, 1); x[s:min(n, s + sample(1:36, 1))] <- NA }; x }
        so <- gap(so); dmask <- gap(rep(1, n))
        keep <- !is.na(pot)
        out_s[[duid]] <- data.table(t = tt, duid = duid, so = so, mk = mkey)[keep & !is.na(so)]
        out_d[[duid]] <- data.table(t = tt, duid = duid, initialmw = c(NA, head(so, -1)), cleared = round(cleared, 2) * dmask,
                                    avail = round(avail, 2) * dmask, uigf = round(uigf, 2) * dmask, mk = mkey)[keep & !is.na(dmask)]
        units[[duid]] <- data.table(duid = duid, region = r, station = duid, name = sprintf("%s %s %02d", sub("1$", "", r), if (tech == "wind") "Wind" else "Solar", k),
                                    tech = tech, schedule = "SEMI-SCHEDULED", dispatch = "GENERATOR", end_date = as.Date("2999-12-31"),
                                    reg_date = reg_date, cap = cap)
        caph[[duid]] <- data.table(duid = duid, eff = reg_date, cap = cap)
      }
      S <- rbindlist(out_s); D <- rbindlist(out_d); tag <- ch[1]
      for (m_ in unique(S$mk)) saveRDS(S[mk == m_, .(t, duid, so)], file.path(parts, sprintf("%d_%s_%03d_scada.rds", m_, r, tag)))
      for (m_ in unique(D$mk)) saveRDS(D[mk == m_, .(t, duid, initialmw, cleared, avail, uigf)], file.path(parts, sprintf("%d_%s_%03d_disp.rds", m_, r, tag)))
      rm(S, D, out_s, out_d); gc(verbose = FALSE)
    }
  }
  units <- rbindlist(units); caph <- rbindlist(caph)
  # one VIC wind unit gets a capacity upgrade mid-history, to exercise the dated capacity lookup
  up <- units[region == "VIC1" & tech == "wind"][1]$duid
  caph <- rbind(caph, data.table(duid = up, eff = as.Date("2024-03-01"), cap = round(units[duid == up]$cap * 1.25, 1)))
  units[duid == up, cap := caph[duid == up][.N]$cap]
  for (mk in sort(unique(mkey))) {
    rd <- function(kind) rbindlist(lapply(list.files(parts, sprintf("^%d_.*_%s\\.rds$", mk, kind), full.names = TRUE), readRDS))
    x <- list(scada = rd("scada"), disp = rd("disp"), price = rd("price"), complete = TRUE, duids = units$duid)
    saveRDS(x, file.path(cache_dir, sprintf("%d.rds", mk)))
  }
  unlink(parts, recursive = TRUE)
  setorder(units, region, tech, duid)
  list(units = units, caph = caph)
}

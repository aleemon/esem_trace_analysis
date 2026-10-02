# Wind and solar unit register, built from the MMSDM registration tables (union over every month fetched).
#   tech      : GENUNITS.CO2E_ENERGY_SOURCE via DUALLOC (latest version), "wind" or "solar"
#   scope     : semi-scheduled generators (DUDETAILSUMMARY.SCHEDULE_TYPE / DISPATCHTYPE on the latest record)
#   capacity  : DUDETAIL.REGISTEREDCAPACITY (MAXCAPACITY as fallback), kept as a dated history
#   reg_date  : earliest DUDETAILSUMMARY.START_DATE / DUDETAIL.EFFECTIVEDATE
# config/units_override.csv (optional; columns duid, tech, cap_mw, name, exclude) corrects anything AEMO has wrong.

build_registry <- function(reg_months, override_file = "config/units_override.csv") {
  u <- function(k) rbindlist(lapply(reg_months, `[[`, k), fill = TRUE)
  dds <- unique(u("DUDETAILSUMMARY")); dd <- unique(u("DUDETAIL")); gu <- unique(u("GENUNITS"))
  da <- unique(u("DUALLOC")); st <- unique(u("STATION"))
  if (!nrow(dds)) stop("no DUDETAILSUMMARY records fetched")
  dds[, `:=`(duid = chr(DUID), s = aemo_date(START_DATE), e = aemo_date(END_DATE))]
  dds[is.na(e), e := as.Date("2999-12-31")]
  latest <- dds[order(duid, -as.numeric(s))][, .SD[1], by = duid]
  first  <- dds[, .(reg_dds = min(s, na.rm = TRUE)), by = duid]
  dd[, `:=`(duid = chr(DUID), eff = aemo_date(EFFECTIVEDATE), ver = num(VERSIONNO),
            cap = fifelse(is.na(num(REGISTEREDCAPACITY)) | num(REGISTEREDCAPACITY) <= 0, num(MAXCAPACITY), num(REGISTEREDCAPACITY)))]
  caph <- dd[order(duid, eff, -ver)][, .SD[1], by = .(duid, eff)][!is.na(cap) & cap > 0, .(duid, eff, cap)]
  first_dd <- dd[, .(reg_dd = min(eff, na.rm = TRUE)), by = duid]
  da[, `:=`(duid = chr(DUID), gid = chr(GENSETID), eff = aemo_date(EFFECTIVEDATE), ver = num(VERSIONNO))]
  da <- da[order(duid, -as.numeric(eff), -ver)]
  da <- da[da[, .I[eff == eff[1] & ver == ver[1]], by = duid]$V1]          # gensets on the latest DUALLOC version
  gu <- unique(gu[, .(gid = chr(GENSETID), src = tolower(chr(CO2E_ENERGY_SOURCE)))], by = "gid")
  tech <- gu[da, on = "gid"][, .(tech = if (any(grepl("wind", src))) "wind" else if (any(grepl("solar", src))) "solar" else NA_character_), by = duid]
  st <- unique(st[, .(station = chr(STATIONID), name = chr(STATIONNAME))], by = "station")

  units <- latest[, .(duid, region = chr(REGIONID), station = chr(STATIONID), schedule = toupper(chr(SCHEDULE_TYPE)),
                      dispatch = toupper(chr(DISPATCHTYPE)), end_date = e)]
  units <- tech[units, on = "duid"]
  units <- st[units, on = "station"]
  units <- first[units, on = "duid"]; units <- first_dd[units, on = "duid"]
  units[, reg_date := pmin(reg_dds, reg_dd, na.rm = TRUE)][, c("reg_dds", "reg_dd") := NULL]
  units[is.na(name) | !nzchar(name), name := duid]
  units <- units[tech %chin% c("wind", "solar") & schedule == "SEMI-SCHEDULED" & dispatch == "GENERATOR" & grepl("^(NSW|QLD|VIC|SA|TAS)1$", region)]
  if (file.exists(override_file)) {
    ov <- fread(override_file, colClasses = "character")
    for (i in seq_len(nrow(ov))) {
      o <- ov[i]; k <- units$duid == o$duid
      if (!is.null(o$exclude) && toupper(o$exclude) %in% c("TRUE", "1", "YES")) { units <- units[!k]; next }
      if (!any(k) && nzchar(o$tech %||% "")) { units <- rbind(units, data.table(duid = o$duid, tech = o$tech, name = o$name %||% o$duid), fill = TRUE); k <- units$duid == o$duid }
      if (nzchar(o$tech %||% "")) units[k, tech := o$tech]
      if (nzchar(o$name %||% "")) units[k, name := o$name]
      if (nzchar(o$cap_mw %||% "")) caph <- rbind(caph[duid != o$duid], data.table(duid = o$duid, eff = as.Date("1990-01-01"), cap = as.numeric(o$cap_mw)))
    }
  }
  caph <- caph[duid %chin% units$duid]
  units[, cap := caph[order(eff)][, .(cap = cap[.N]), by = duid][units, on = "duid"]$cap]
  units <- units[!is.na(cap) & cap > 0]
  setorder(units, region, tech, duid)
  list(units = units, caph = caph)
}

# capacity in force on a date (latest effective record on or before it; the earliest record if none yet)
cap_at <- function(caph, duids, date) {
  h <- caph[duid %chin% duids][order(duid, eff)]
  h[, .(cap = if (any(eff <= date)) cap[max(which(eff <= date))] else cap[1]), by = duid][match(duids, duid)]$cap
}

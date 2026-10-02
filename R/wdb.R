# WDB1 container: "WDB1" | uint32 LE header length | JSON header (padded so the body starts on 8 bytes)
# | series blobs, each 8-byte aligned. The whole file is gzipped. Read by site/app.js (fetchBin/decodeSeries).

DT_SEC   <- 300L
MW_SCALE <- 1.0   # explorer resolution only; index and settlement are computed before quantising
CF_SCALE <- 1e-4

na_runs <- function(na) {
  if (!any(na)) return(list())
  r <- rle(na); ends <- cumsum(r$lengths); starts <- ends - r$lengths
  mapply(function(s, l) c(s, l), starts[r$values], r$lengths[r$values], SIMPLIFY = FALSE, USE.NAMES = FALSE)
}

# delta Int16, byte-split (all low bytes, then all high bytes); NA runs go to the header
enc_d16s <- function(x, scale) {
  q <- round(x / scale)
  gaps <- na_runs(is.na(q))
  q <- nafill(q, type = "locf"); q[is.na(q)] <- 0
  d <- as.integer(diff(c(0, q)))
  if (any(d < -32768L | d > 32767L)) stop("delta overflow: scale too fine for this series")
  list(bytes = c(as.raw(bitwAnd(d, 255L)), as.raw(bitwAnd(bitwShiftR(d, 8L), 255L))), gaps = gaps)
}
enc_f32 <- function(x) writeBin(as.numeric(x), raw(), size = 4, endian = "little")

write_wdb <- function(path, header, blobs, series) {
  sizes <- vapply(blobs, length, 1L)
  pads  <- integer(length(blobs)); off <- integer(length(blobs)); pos <- 0L
  for (i in seq_along(blobs)) {
    pads[i] <- (-pos) %% 8L; pos <- pos + pads[i]; off[i] <- pos; pos <- pos + sizes[i]
    series[[i]]$off <- off[i]; series[[i]]$len <- sizes[i]
  }
  header$series <- series
  hj <- charToRaw(as.character(jsonlite::toJSON(header, auto_unbox = TRUE, digits = NA, null = "null")))
  hj <- c(hj, rep(charToRaw(" "), (-(length(hj) + 8L)) %% 8L))
  dir.create(dirname(path), recursive = TRUE, showWarnings = FALSE)
  tmp <- paste0(path, ".tmp")
  con <- gzfile(tmp, "wb", compression = 9)
  writeBin(charToRaw("WDB1"), con)
  writeBin(length(hj), con, size = 4, endian = "little")
  writeBin(hj, con)
  for (i in seq_along(blobs)) { if (pads[i]) writeBin(raw(pads[i]), con); writeBin(blobs[[i]], con) }
  close(con)
  file.rename(tmp, path)
  file.size(path)
}

# ---- reader, for tests and round-trip checks ----
read_wdb <- function(path) {
  con <- gzfile(path, "rb"); on.exit(close(con))
  raw <- readBin(con, "raw", 2^31 - 1)
  stopifnot(rawToChar(raw[1:4]) == "WDB1")
  hl <- readBin(raw[5:8], "integer", size = 4, endian = "little")
  list(h = jsonlite::fromJSON(rawToChar(raw[9:(8 + hl)]), simplifyVector = FALSE), raw = raw, body = 8L + hl)
}
decode_series <- function(w, id, base = NULL) {
  s <- Filter(function(z) z$id == id, w$h$series)[[1]]; n <- w$h$n %||% NA
  b <- w$raw[(w$body + s$off + 1):(w$body + s$off + s$len)]
  if (s$enc == "f32") return(readBin(b, "numeric", s$len / 4, size = 4, endian = "little"))
  n <- s$len / 2
  d <- as.integer(b[1:n]) + 256L * as.integer(b[(n + 1):(2 * n)]); d[d > 32767L] <- d[d > 32767L] - 65536L
  x <- cumsum(d) * s$scale
  if (!is.null(base)) x <- x + ifelse(is.na(base), 0, base)
  for (g in s$gaps) x[(g[[1]] + 1):(g[[1]] + g[[2]])] <- NA
  x
}
`%||%` <- function(a, b) if (is.null(a)) b else a

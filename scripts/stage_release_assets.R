#!/usr/bin/env Rscript
# Seed the "data-aemo" release from your own machine, where NEMWeb is reachable.
#   1. DATA_SOURCE=aemo Rscript run.R              (fetches and builds locally into ./cache)
#   2. Rscript scripts/stage_release_assets.R      (copies the immutable extracts into ./release_upload)
#   3. On GitHub: Releases -> Draft a new release -> tag "data-aemo" -> tick "Set as a pre-release"
#      -> drag every file from ./release_upload into the assets box -> Publish release
# The workflow then restores these instead of downloading them, and keeps the release up to date itself.
cache <- Sys.getenv("CACHE_DIR", "cache"); out <- "release_upload"
dir.create(out, showWarnings = FALSE)
man <- character()
put <- function(src, name) { file.copy(src, file.path(out, name), overwrite = TRUE); man <<- c(man, paste(name, unname(tools::md5sum(src)), sep = "\t")) }
for (f in Sys.glob(file.path(cache, "nem", "[0-9][0-9][0-9][0-9][0-9][0-9].rds"))) if (isTRUE(readRDS(f)$complete)) put(f, paste0("nem_", basename(f)))
for (f in Sys.glob(file.path(cache, "registry", "*.rds"))) put(f, paste0("registry_", basename(f)))
writeLines(man, file.path(out, "manifest.tsv"))
cat(sprintf("%d files staged in %s/ (%.0f MB)\n", length(man) + 1, out, sum(file.size(list.files(out, full.names = TRUE))) / 1e6))

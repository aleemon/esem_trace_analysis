#!/usr/bin/env bash
# Durable copy of the fetched AEMO extracts as assets on a GitHub release (tag "data-<DATA_SOURCE>").
# The Actions cache is fast but evictable (7 days unused, 10 GB per repo); the release is the permanent copy.
#
#   restore : download any release asset whose local file is missing (run after the Actions cache restore)
#   publish : upload complete MMSDM months, registration months and benchmark.md that are new or changed
#
# Only immutable inputs are backed up: complete MMSDM months (cache/nem/YYYYMM.rds with complete = TRUE) and
# registration months (cache/registry/YYYYMM.rds). Daily-built months and build outputs are cheap to recreate.
# Needs: gh (preinstalled on GitHub runners), GH_TOKEN with contents: write, GITHUB_REPOSITORY.
set -euo pipefail
MODE="${1:?usage: release_sync.sh restore|publish}"
SRC="${DATA_SOURCE:-synthetic}"
TAG="data-${SRC}"
CACHE="${CACHE_DIR:-cache}"
REPO_ARGS=(--repo "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY not set}")
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

asset_to_path() {   # nem_202401.rds -> cache/nem/202401.rds ; registry_202401.rds -> cache/registry/202401.rds
  case "$1" in
    nem_*.rds)      echo "$CACHE/nem/${1#nem_}" ;;
    registry_*.rds) echo "$CACHE/registry/${1#registry_}" ;;
    *)              echo "" ;;
  esac
}

if [[ "$MODE" == "restore" ]]; then
  if ! gh release view "$TAG" "${REPO_ARGS[@]}" >/dev/null 2>&1; then echo "no release $TAG yet: nothing to restore"; exit 0; fi
  n=0
  while IFS= read -r name; do
    dest="$(asset_to_path "$name")"; [[ -z "$dest" || -f "$dest" ]] && continue
    mkdir -p "$(dirname "$dest")"
    gh release download "$TAG" "${REPO_ARGS[@]}" --pattern "$name" --dir "$tmp" --clobber
    mv "$tmp/$name" "$dest"; n=$((n + 1))
  done < <(gh release view "$TAG" "${REPO_ARGS[@]}" --json assets --jq '.assets[].name')
  echo "restored $n file(s) from release $TAG"
  exit 0
fi

if [[ "$MODE" != "publish" ]]; then echo "unknown mode $MODE"; exit 2; fi
if ! gh release view "$TAG" "${REPO_ARGS[@]}" >/dev/null 2>&1; then
  gh release create "$TAG" "${REPO_ARGS[@]}" --prerelease --target "${GITHUB_SHA:-main}" --title "Data cache ($SRC)" \
    --notes "Filtered AEMO extracts written by the nightly build: nem_YYYYMM.rds (SCADA, DISPATCHLOAD columns and regional prices for one MMSDM month) and registry_YYYYMM.rds (registration tables). Read in R with readRDS(). Maintained automatically; do not edit by hand."
fi
# current manifest (asset name <TAB> md5) from the release, if any
gh release download "$TAG" "${REPO_ARGS[@]}" --pattern manifest.tsv --dir "$tmp" 2>/dev/null || : > "$tmp/manifest.tsv"
# local candidates: complete months + registry months + benchmark report
Rscript --vanilla -e '
  cache <- Sys.getenv("CACHE_DIR", "cache")
  out <- character()
  for (f in Sys.glob(file.path(cache, "nem", "[0-9][0-9][0-9][0-9][0-9][0-9].rds"))) {
    x <- readRDS(f); if (isTRUE(x$complete)) out <- c(out, paste(f, paste0("nem_", basename(f)), sep = "\t"))
  }
  for (f in Sys.glob(file.path(cache, "registry", "*.rds"))) out <- c(out, paste(f, paste0("registry_", basename(f)), sep = "\t"))
  f <- file.path(cache, "out", "benchmark.md"); if (file.exists(f)) out <- c(out, paste(f, "benchmark.md", sep = "\t"))
  writeLines(out)' > "$tmp/local.tsv"
: > "$tmp/new_manifest.tsv"; up=0
while IFS=$'\t' read -r path name; do
  [[ -z "$path" ]] && continue
  sum="$(md5sum "$path" | cut -d" " -f1)"
  printf '%s\t%s\n' "$name" "$sum" >> "$tmp/new_manifest.tsv"
  old="$(awk -F'\t' -v n="$name" '$1 == n {print $2}' "$tmp/manifest.tsv")"
  if [[ "$sum" != "$old" ]]; then
    cp "$path" "$tmp/$name"
    gh release upload "$TAG" "${REPO_ARGS[@]}" "$tmp/$name" --clobber
    rm -f "$tmp/$name"; up=$((up + 1))
  fi
done < "$tmp/local.tsv"
# keep manifest entries for assets that exist on the release but not locally (e.g. after a partial cache restore)
awk -F'\t' 'NR == FNR {seen[$1] = 1; next} !($1 in seen)' "$tmp/new_manifest.tsv" "$tmp/manifest.tsv" >> "$tmp/new_manifest.tsv"
cp "$tmp/new_manifest.tsv" "$tmp/manifest.tsv.new" && mv "$tmp/manifest.tsv.new" "$tmp/manifest.tsv"
gh release upload "$TAG" "${REPO_ARGS[@]}" "$tmp/manifest.tsv" --clobber
echo "uploaded $up file(s) to release $TAG"

#!/usr/bin/env bash
# Azure counterpart of release_sync.sh: durable copy of the fetched AEMO extracts in an Azure Blob Storage container,
# under the prefix "<DATA_SOURCE>/" (e.g. aemo/nem_202401.rds). The pipeline cache is fast but evictable; the blob
# container is the permanent copy.
#
#   restore : download any blob whose local file is missing (run after the pipeline cache restore)
#   publish : upload complete MMSDM months, predispatch months, registration months and the reports when new or changed
#   seed    : one-off copy of every asset on the GitHub release "data-<DATA_SOURCE>" of GITHUB_REPO (owner/name) into
#             the container, so the first Azure build does not refetch years of NEMWeb data
#
# Same file names and the same manifest.tsv (name <TAB> md5) as the GitHub release, so scripts/stage_release_assets.R
# output can also be uploaded to the container by hand (Storage browser > container > Upload, into folder "aemo").
# Needs: az CLI logged in (AzureCLI@2 task) with "Storage Blob Data Contributor" on the account,
#        STORAGE_ACCOUNT, STORAGE_CONTAINER.
set -euo pipefail
MODE="${1:?usage: blob_sync.sh restore|publish|seed}"
SRC="${DATA_SOURCE:-synthetic}"
PREFIX="${SRC}/"
CACHE="${CACHE_DIR:-cache}"
AZ=(--account-name "${STORAGE_ACCOUNT:?STORAGE_ACCOUNT not set}" --container-name "${STORAGE_CONTAINER:?STORAGE_CONTAINER not set}" --auth-mode login --only-show-errors)
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

asset_to_path() {   # nem_202401.rds -> cache/nem/202401.rds ; registry_202401.rds -> cache/registry/202401.rds
  case "$1" in
    nem_*.rds)      echo "$CACHE/nem/${1#nem_}" ;;
    registry_*.rds) echo "$CACHE/registry/${1#registry_}" ;;
    pd_*.rds)       echo "$CACHE/pd/${1#pd_}" ;;
    *)              echo "" ;;
  esac
}
list_blobs() { az storage blob list "${AZ[@]}" --prefix "$PREFIX" --num-results "*" --query "[].name" -o tsv | sed "s#^${PREFIX}##"; }

if [[ "$MODE" == "restore" ]]; then
  list_blobs > "$tmp/remote.txt"
  : > "$tmp/missing.txt"
  while IFS= read -r name; do
    dest="$(asset_to_path "$name")"; [[ -z "$dest" || -f "$dest" ]] && continue
    echo "$name" >> "$tmp/missing.txt"
  done < "$tmp/remote.txt"
  n="$(wc -l < "$tmp/missing.txt")"
  if (( n == 0 )); then echo "nothing to restore ($(wc -l < "$tmp/remote.txt") blob(s) under $PREFIX)"; exit 0; fi
  mkdir -p "$tmp/dl"
  if (( n > 10 )); then   # one parallel batch download beats many single CLI calls
    az storage blob download-batch --account-name "$STORAGE_ACCOUNT" --source "$STORAGE_CONTAINER" --auth-mode login --only-show-errors \
      --pattern "${PREFIX}*" --destination "$tmp/dl" --max-connections 8 > /dev/null
  else
    while IFS= read -r name; do
      mkdir -p "$tmp/dl/$PREFIX"
      az storage blob download "${AZ[@]}" --name "$PREFIX$name" --file "$tmp/dl/$PREFIX$name" > /dev/null
    done < "$tmp/missing.txt"
  fi
  while IFS= read -r name; do
    dest="$(asset_to_path "$name")"; mkdir -p "$(dirname "$dest")"; mv "$tmp/dl/$PREFIX$name" "$dest"
  done < "$tmp/missing.txt"
  echo "restored $n file(s) from $STORAGE_ACCOUNT/$STORAGE_CONTAINER/$PREFIX"
  exit 0
fi

if [[ "$MODE" == "seed" ]]; then
  REPO="${GITHUB_REPO:?GITHUB_REPO (owner/name) not set}"; TAG="data-${SRC}"
  curl -fsSL "https://api.github.com/repos/$REPO/releases/tags/$TAG" -o "$tmp/release.json"
  mkdir -p "$tmp/up"
  jq -r '.assets[] | [.name, .browser_download_url] | @tsv' "$tmp/release.json" > "$tmp/assets.tsv"
  echo "downloading $(wc -l < "$tmp/assets.tsv") asset(s) from $REPO release $TAG"
  while IFS=$'\t' read -r name url; do curl -fsSL --retry 3 -o "$tmp/up/$name" "$url"; done < "$tmp/assets.tsv"
  az storage blob upload-batch --account-name "$STORAGE_ACCOUNT" --destination "$STORAGE_CONTAINER" --auth-mode login --only-show-errors \
    --destination-path "${SRC}" --source "$tmp/up" --overwrite true --max-connections 8 > /dev/null
  echo "seeded $(ls "$tmp/up" | wc -l) file(s) into $STORAGE_ACCOUNT/$STORAGE_CONTAINER/$PREFIX"
  # also drop them into the local cache, so the restore step that follows has nothing to download again
  for f in "$tmp/up"/*; do
    dest="$(asset_to_path "$(basename "$f")")"; [[ -z "$dest" || -f "$dest" ]] && continue
    mkdir -p "$(dirname "$dest")"; mv "$f" "$dest"
  done
  exit 0
fi

if [[ "$MODE" != "publish" ]]; then echo "unknown mode $MODE"; exit 2; fi
# current manifest (asset name <TAB> md5), if any
az storage blob download "${AZ[@]}" --name "${PREFIX}manifest.tsv" --file "$tmp/manifest.tsv" > /dev/null 2>&1 || : > "$tmp/manifest.tsv"
# local candidates: complete months + registry months + reports
Rscript --vanilla -e '
  cache <- Sys.getenv("CACHE_DIR", "cache")
  out <- character()
  for (f in Sys.glob(file.path(cache, "nem", "[0-9][0-9][0-9][0-9][0-9][0-9].rds"))) {
    x <- readRDS(f); if (isTRUE(x$complete)) out <- c(out, paste(f, paste0("nem_", basename(f)), sep = "\t"))
  }
  for (f in Sys.glob(file.path(cache, "registry", "*.rds"))) out <- c(out, paste(f, paste0("registry_", basename(f)), sep = "\t"))
  for (f in Sys.glob(file.path(cache, "pd", "[0-9][0-9][0-9][0-9][0-9][0-9].rds"))) {
    x <- readRDS(f); if (isTRUE(x$complete)) out <- c(out, paste(f, paste0("pd_", basename(f)), sep = "\t"))
  }
  for (b in c("benchmark.md", "fetch_report.md")) { f <- file.path(cache, "out", b); if (file.exists(f)) out <- c(out, paste(f, b, sep = "\t")) }
  writeLines(out)' > "$tmp/local.tsv"
: > "$tmp/new_manifest.tsv"; up=0
while IFS=$'\t' read -r path name; do
  [[ -z "$path" ]] && continue
  sum="$(md5sum "$path" | cut -d" " -f1)"
  printf '%s\t%s\n' "$name" "$sum" >> "$tmp/new_manifest.tsv"
  old="$(awk -F'\t' -v n="$name" '$1 == n {print $2}' "$tmp/manifest.tsv")"
  if [[ "$sum" != "$old" ]]; then
    az storage blob upload "${AZ[@]}" --name "$PREFIX$name" --file "$path" --overwrite true > /dev/null
    up=$((up + 1))
  fi
done < "$tmp/local.tsv"
# keep manifest entries for blobs that exist remotely but not locally (e.g. after a partial cache restore)
awk -F'\t' 'NR == FNR {seen[$1] = 1; next} !($1 in seen)' "$tmp/new_manifest.tsv" "$tmp/manifest.tsv" >> "$tmp/new_manifest.tsv"
az storage blob upload "${AZ[@]}" --name "${PREFIX}manifest.tsv" --file "$tmp/new_manifest.tsv" --overwrite true > /dev/null
echo "uploaded $up file(s) to $STORAGE_ACCOUNT/$STORAGE_CONTAINER/$PREFIX"

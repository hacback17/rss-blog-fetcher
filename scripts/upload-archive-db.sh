#!/usr/bin/env bash
set -euo pipefail

release_tag="${ARCHIVE_DB_RELEASE_TAG:-archive-database}"
asset_name="${ARCHIVE_DB_ASSET_NAME:-blogs.db}"
db_path="${ARCHIVE_DB_PATH:-data/blogs.db}"

if [[ ! -f "$db_path" ]]; then
  echo "::error::Archive database not found at $db_path."
  exit 1
fi

magic="$(od -An -tx1 -N16 "$db_path" | tr -d ' \n')"
if [[ "$magic" != "53514c69746520666f726d6174203300" ]]; then
  echo "::error::$db_path is not a valid SQLite database."
  exit 1
fi

if ! gh release view "$release_tag" >/dev/null 2>&1; then
  gh release create "$release_tag" \
    --title "Archive database" \
    --notes "Mutable SQLite database used by the scraper and GitHub Pages. Managed automatically by GitHub Actions." \
    --latest=false
fi

gh release upload "$release_tag" "$db_path#$asset_name" --clobber
echo "Uploaded $asset_name to release $release_tag ($(sha256sum "$db_path" | cut -d' ' -f1))."

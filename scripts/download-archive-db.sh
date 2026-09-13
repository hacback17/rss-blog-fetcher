#!/usr/bin/env bash
set -euo pipefail

release_tag="${ARCHIVE_DB_RELEASE_TAG:-archive-database}"
asset_name="${ARCHIVE_DB_ASSET_NAME:-blogs.db}"
db_path="${ARCHIVE_DB_PATH:-data/blogs.db}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "$(dirname "$db_path")"

if gh release download "$release_tag" --pattern "$asset_name" --dir "$tmp_dir"; then
  mv "$tmp_dir/$asset_name" "$db_path"
  echo "Downloaded $asset_name from release $release_tag."
elif [[ -f "$db_path" ]]; then
  # This fallback is only for the one-time migration run while the database
  # still exists in Git. Once the release is seeded and the tracked copy is
  # removed, a missing release is a hard failure rather than a fresh archive.
  echo "Release asset not found; using the tracked database as the migration seed."
else
  echo "::error::Archive database release asset '$release_tag/$asset_name' is missing."
  exit 1
fi

magic="$(od -An -tx1 -N16 "$db_path" | tr -d ' \n')"
if [[ "$magic" != "53514c69746520666f726d6174203300" ]]; then
  echo "::error::$db_path is not a valid SQLite database."
  exit 1
fi

echo "ARCHIVE_DB_SHA256=$(sha256sum "$db_path" | cut -d' ' -f1)" >> "${GITHUB_ENV:-/dev/null}"

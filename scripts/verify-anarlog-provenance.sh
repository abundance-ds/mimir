#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]] || ! git -C "$1" rev-parse --git-dir >/dev/null 2>&1; then
  echo "usage: scripts/verify-anarlog-provenance.sh /path/to/anarlog" >&2
  exit 2
fi

upstream_root=$(cd "$1" && pwd -P)
script_root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
mimir_root=$(cd "$script_root/.." && pwd -P)
metadata="$mimir_root/src-tauri/vendor/anarlog/UPSTREAM"
manifest="$mimir_root/src-tauri/vendor/anarlog/import-manifest.tsv"
preserved_license="$mimir_root/src-tauri/vendor/anarlog/LICENSE"

expected_repository=
expected_commit=
while IFS='=' read -r key value; do
  case "$key" in
    repository) expected_repository=$value ;;
    commit) expected_commit=$value ;;
  esac
done < "$metadata"

if [[ -z "$expected_repository" || -z "$expected_commit" ]]; then
  echo "invalid provenance metadata: missing repository or commit" >&2
  exit 1
fi

actual_commit=$(git -C "$upstream_root" rev-parse HEAD)
if [[ "$actual_commit" != "$expected_commit" ]]; then
  echo "commit mismatch: expected $expected_commit, got $actual_commit" >&2
  exit 1
fi

actual_remote=$(git -C "$upstream_root" remote get-url origin 2>/dev/null || true)
case "$actual_remote" in
  "$expected_repository"|"${expected_repository%.git}"|git@github.com:fastrepl/anarlog.git) ;;
  *)
    echo "warning: origin is '$actual_remote'; canonical source is '$expected_repository'" >&2
    ;;
esac

hash_stream() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    echo "neither shasum nor sha256sum is available" >&2
    return 1
  fi
}

hash_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

checked=0
while IFS=$'\t' read -r expected_hash disposition component upstream_path destination_hint rationale; do
  [[ -z "$expected_hash" || "${expected_hash:0:1}" == "#" ]] && continue

  if [[ ! "$expected_hash" =~ ^[0-9a-f]{64}$ ]]; then
    echo "invalid SHA-256 in manifest for '$upstream_path'" >&2
    exit 1
  fi

  case "$disposition" in
    notice|candidate|adapt|reference|reject|legal-hold) ;;
    *)
      echo "invalid disposition '$disposition' for '$upstream_path'" >&2
      exit 1
      ;;
  esac

  if ! git -C "$upstream_root" cat-file -e "$expected_commit:$upstream_path" 2>/dev/null; then
    echo "missing upstream file at pin: $upstream_path" >&2
    exit 1
  fi

  actual_hash=$(git -C "$upstream_root" show "$expected_commit:$upstream_path" | hash_stream)
  if [[ "$actual_hash" != "$expected_hash" ]]; then
    echo "hash mismatch for $upstream_path" >&2
    echo "  expected: $expected_hash" >&2
    echo "  actual:   $actual_hash" >&2
    exit 1
  fi
  checked=$((checked + 1))
done < "$manifest"

upstream_license_hash=$(git -C "$upstream_root" show "$expected_commit:LICENSE" | hash_stream)
preserved_license_hash=$(hash_file "$preserved_license")
if [[ "$preserved_license_hash" != "$upstream_license_hash" ]]; then
  echo "preserved LICENSE differs from pinned upstream LICENSE" >&2
  exit 1
fi

echo "Anarlog provenance verified: $checked files at $expected_commit"

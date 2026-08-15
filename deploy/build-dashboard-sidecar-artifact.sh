#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_dir=${1:-"$repo_root/dist/dashboard-sidecar"}
esbuild_bin=${ESBUILD_BIN:-"$repo_root/node_modules/.bin/esbuild"}
metadata=$(mktemp)
trap 'rm -f "$metadata"' EXIT HUP INT TERM

allowed_inputs='scripts/run-dashboard-sidecar.ts
src/dashboard/DashboardSnapshotSidecar.ts
src/dashboard/DashboardService.ts
src/dashboard/server.ts'

mkdir -p "$output_dir"
find "$output_dir" -mindepth 1 -maxdepth 1 -type f \
  \( -name 'dashboard.html' -o -name 'run-dashboard-sidecar.js' \) -delete

"$esbuild_bin" "$repo_root/scripts/run-dashboard-sidecar.ts" \
  --bundle --platform=node --format=esm --target=node20 \
  --outfile="$output_dir/run-dashboard-sidecar.js" --metafile="$metadata"

actual_inputs=$(node -e 'const fs=require("node:fs"); const root=process.argv[1]+"/"; const meta=JSON.parse(fs.readFileSync(process.argv[2],"utf8")); console.log(Object.keys(meta.inputs).map(p=>p.startsWith(root)?p.slice(root.length):p).sort().join("\n"))' "$repo_root" "$metadata")
expected_inputs=$(printf '%s\n' "$allowed_inputs" | sort)
if [ "$actual_inputs" != "$expected_inputs" ]; then
  printf '%s\n' "Refusing artifact: imports differ from the exact allowlist." >&2
  printf '%s\n' "$actual_inputs" >&2
  exit 1
fi

cp "$repo_root/src/dashboard/dashboard.html" "$output_dir/dashboard.html"
artifact_files=$(find "$output_dir" -mindepth 1 -printf '%P\n' | sort)
if [ "$artifact_files" != 'dashboard.html
run-dashboard-sidecar.js' ]; then
  printf '%s\n' "Refusing artifact: forbidden file in output." >&2
  exit 1
fi
chmod 0750 "$output_dir/run-dashboard-sidecar.js"
chmod 0640 "$output_dir/dashboard.html"

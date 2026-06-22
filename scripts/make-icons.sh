#!/usr/bin/env bash
#
# Regenerate icons/icon-{16,32,48,128}.png from icons/*.svg.
#
# Uses @resvg/resvg-js@2.6.2 to render. The CLI build of resvg-js was
# beta-only at the time of writing, so we drive the library directly:
# install it into a throw-away node_modules in /tmp, then run a small
# Node script that requires it.
#
# Run from anywhere:
#   bash scripts/make-icons.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

RESVG_VERSION="2.6.2"

# Install resvg-js into a temp directory (deleted on exit) so we never
# touch this repo's tree or any global location.
TMPDIR_RESVG="$(mktemp -d -t resvg-icons-XXXXXX)"
trap 'rm -rf "$TMPDIR_RESVG"' EXIT
echo "Installing @resvg/resvg-js@${RESVG_VERSION} into ${TMPDIR_RESVG}..."
(cd "$TMPDIR_RESVG" && npm install --silent --no-save --no-audit --no-fund \
  --prefix "$TMPDIR_RESVG" "@resvg/resvg-js@${RESVG_VERSION}")

RENDER_SCRIPT="$TMPDIR_RESVG/render.mjs"
cat > "$RENDER_SCRIPT" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(process.env.RESVG_PREFIX + "/");
const { Resvg } = require("@resvg/resvg-js");
const [src, sizeStr, out] = process.argv.slice(2);
const size = Number(sizeStr);
const svg = readFileSync(src);
const png = new Resvg(svg, {
  fitTo: { mode: "width", value: size },
}).render().asPng();
writeFileSync(out, png);
EOF

render() {
  local src=$1 size=$2 out=$3
  RESVG_PREFIX="$TMPDIR_RESVG/node_modules" \
    node "$RENDER_SCRIPT" "$src" "$size" "$out"
  echo "  wrote $out (${size}x${size})"
}

echo "Regenerating icons/*.png..."
render icons/icon-16.svg 16  icons/icon-16.png
render icons/icon.svg    32  icons/icon-32.png
render icons/icon.svg    48  icons/icon-48.png
render icons/icon.svg    128 icons/icon-128.png
echo "Done."

#!/usr/bin/env bash
# Rebuild dist/ — the committed, browser-ready JS the frontend imports.
#
# dist/ is checked in so that a clone without the Gleam toolchain can still
# build and test the app. Run this after touching anything under src/.
set -euo pipefail

cd "$(dirname "$0")"

npm install
gleam build --target javascript
node dev/dist.mjs

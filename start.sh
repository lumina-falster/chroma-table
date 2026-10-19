#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if [ -x ./runtime/node ]; then
  exec ./runtime/node server.js
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Please install Node.js 22.8+: https://nodejs.org/" >&2
  exit 1
fi
exec node server.js

#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found."
  exit 1
fi

if ! command -v go >/dev/null 2>&1; then
  echo "Go 1.22+ is required for the Elasticsearch Go engine but was not found."
  exit 1
fi

# When ELECTRON_RUN_AS_NODE=1 leaks from the user environment (some shells /
# IDEs export it to embed Electron as a Node runtime), electron-vite's spawned
# Electron process inherits the flag and runs as plain Node, so electron.app
# is undefined and the GUI window never opens. Unset it for the dev session.
unset ELECTRON_RUN_AS_NODE
unset ELECTRON_NO_ATTACH_CONSOLE
unset ELECTRON_DISABLE_SANDBOX

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Starting DataMigrator..."
exec npm run dev
#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cliPath = fileURLToPath(
  new URL('../node_modules/electron-vite/bin/electron-vite.js', import.meta.url)
)
const env = { ...process.env }

delete env.ELECTRON_RUN_AS_NODE

const result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
  env,
  stdio: 'inherit'
})

if (result.error) {
  throw result.error
}

process.exit(result.status ?? 1)

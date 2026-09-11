import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const moduleDir = join(root, 'golang', 'esmigrator')
const targetPlatform = process.argv[2] ?? process.platform
const targetArch = process.argv[3] ?? process.arch
const binaryName = targetPlatform === 'win32' ? 'esmigrator.exe' : 'esmigrator'
const binDir = join(moduleDir, 'bin')
mkdirSync(binDir, { recursive: true })

const env = { ...process.env }
if (targetPlatform !== process.platform) {
  env.GOOS = targetPlatform === 'win32' ? 'windows' : targetPlatform
  env.GOARCH = targetArch === 'arm64' ? 'arm64' : 'amd64'
}

const result = spawnSync(
  'go',
  ['build', '-trimpath', '-o', join(binDir, binaryName), '.'],
  {
    cwd: moduleDir,
    env,
    stdio: 'inherit'
  }
)

if (result.error) {
  console.error(result.error)
  process.exit(1)
}
process.exit(result.status ?? 1)

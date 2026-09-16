import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app } from 'electron'

import type {
  AccessConnectionTestResult,
  AccessExportRequest,
  AccessMigrationResult,
  ConnectionConfig
} from '../shared/types'
import { TaskCancelledError } from './task-errors'

interface GoAccessServiceOptions {
  binaryPath?: string
}

interface GoControlFiles {
  progressFile: string
  cancelFile: string
}

interface AccessProgress {
  rows: number
  canceled?: boolean
}

interface AccessProcessResult {
  rows?: number
}

export class GoAccessService {
  private readonly binaryPath: string

  constructor(options: GoAccessServiceOptions = {}) {
    this.binaryPath = options.binaryPath ?? resolveAccessBinaryPath()
    if (!existsSync(this.binaryPath)) {
      throw new Error(
        `未找到 Access Go 引擎：${this.binaryPath}，请先运行 npm run build:go`
      )
    }
  }

  async testConnection(connection: ConnectionConfig): Promise<AccessConnectionTestResult> {
    try {
      const tables = await this.listTables(connection)
      return { ok: true, tables }
    } catch (error) {
      return { ok: false, message: accessErrorMessage(error) }
    }
  }

  async listTables(connection: ConnectionConfig): Promise<string[]> {
    const output = await this.runCommand([
      'list-tables',
      '--file',
      accessFilePath(connection),
      ...passwordArgs(connection)
    ])
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  }

  async exportTable(
    connection: ConnectionConfig,
    request: AccessExportRequest,
    onProgress?: (processedRows: number, cursor?: unknown) => void,
    resumeRows = 0
  ): Promise<AccessMigrationResult> {
    const startedAt = performance.now()
    const control = await createControlFiles(request.outputFile)
    const args = [
      'export',
      '--file',
      accessFilePath(connection),
      '--table',
      request.table,
      '--output',
      request.outputFile,
      '--batch-size',
      String(request.batchSize),
      '--progress-file',
      control.progressFile,
      '--cancel-file',
      control.cancelFile,
      ...passwordArgs(connection)
    ]
    if (resumeRows > 0) {
      args.push('--resume-rows', String(resumeRows))
    }

    try {
      const output = await this.runProcess(args, control, (progress) => {
        onProgress?.(progress.rows, progress.rows)
      })
      const info = await stat(request.outputFile)
      return {
        rows: output.result?.rows ?? output.progress?.rows ?? resumeRows,
        bytes: info.size,
        durationMs: Math.round(performance.now() - startedAt),
        table: request.table
      }
    } finally {
      await removeControlFiles(control)
    }
  }

  private runCommand(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binaryPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (signal) {
          reject(new Error(`Access Go 引擎被信号终止：${signal}`))
          return
        }
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Access Go 引擎退出码：${code ?? 1}`))
          return
        }
        resolve(stdout)
      })
    })
  }

  private async runProcess(
    args: string[],
    control: GoControlFiles,
    onProgress: (progress: AccessProgress) => void
  ): Promise<{ progress?: AccessProgress; result?: AccessProcessResult }> {
    const child = spawn(this.binaryPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let latest: AccessProgress | undefined
    let cancelledByCallback = false

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    const completion = new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (cancelledByCallback) {
          resolve(3)
          return
        }
        if (signal) {
          reject(new Error(`Access Go 引擎被信号终止：${signal}`))
          return
        }
        resolve(code ?? 1)
      })
    })

    const timer = setInterval(() => {
      void (async () => {
        try {
          const progress = await readProgress(control.progressFile)
          if (!progress) {
            return
          }
          latest = progress
          onProgress(progress)
        } catch (error) {
          if (error instanceof TaskCancelledError) {
            cancelledByCallback = true
            clearInterval(timer)
            await writeFile(control.cancelFile, 'cancel', 'utf8').catch(() => undefined)
            child.kill()
          }
        }
      })()
    }, 250)

    try {
      const code = await completion
      if (code === 3) {
        throw new TaskCancelledError('go-access')
      }
      if (code !== 0) {
        throw new Error(stderr.trim() || `Access Go 引擎退出码：${code}`)
      }
      return {
        progress: latest,
        result: parseResult(stdout)
      }
    } finally {
      clearInterval(timer)
    }
  }
}

async function createControlFiles(basePath: string): Promise<GoControlFiles> {
  const progressFile = `${basePath}.go-progress.json`
  const cancelFile = `${basePath}.go-cancel`
  await Promise.all([
    rm(progressFile, { force: true }).catch(() => undefined),
    rm(cancelFile, { force: true }).catch(() => undefined)
  ])
  return { progressFile, cancelFile }
}

async function removeControlFiles(control: GoControlFiles): Promise<void> {
  await Promise.all([
    rm(control.progressFile, { force: true }).catch(() => undefined),
    rm(control.cancelFile, { force: true }).catch(() => undefined)
  ])
}

async function readProgress(path: string): Promise<AccessProgress | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isRecord(parsed) || typeof parsed.rows !== 'number') {
      return null
    }
    return parsed as unknown as AccessProgress
  } catch {
    return null
  }
}

function parseResult(stdout: string): AccessProcessResult | undefined {
  const lines = stdout
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed: unknown = JSON.parse(lines[index] ?? '')
      if (isRecord(parsed) && typeof parsed.rows === 'number') {
        return parsed as unknown as AccessProcessResult
      }
    } catch {
      // Keep looking for the result line.
    }
  }
  return undefined
}

function accessFilePath(connection: ConnectionConfig): string {
  const filePath = (connection.filePath ?? connection.host).trim()
  if (filePath.length === 0) {
    throw new Error('Access 数据库文件路径不能为空')
  }
  return filePath
}

function passwordArgs(connection: ConnectionConfig): string[] {
  return connection.password ? ['--password', connection.password] : []
}

function resolveAccessBinaryPath(): string {
  const binaryName = process.platform === 'win32' ? 'accessmigrator.exe' : 'accessmigrator'
  const candidates = [
    join(process.resourcesPath, 'go-bin', binaryName),
    join(app.getAppPath(), 'golang', 'accessmigrator', 'bin', binaryName),
    join(process.cwd(), 'golang', 'accessmigrator', 'bin', binaryName)
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error('未找到 Access Go 引擎二进制文件')
}

function accessErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('mdb-tables') && /not found|executable file/i.test(message)) {
    return `${message}（请先安装 mdbtools 并将 mdb-tables 加入 PATH）`
  }
  return message
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

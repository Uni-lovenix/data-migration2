import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app } from 'electron'

import type {
  ConnectionConfig,
  ElasticsearchExportRequest,
  ElasticsearchImportRequest,
  ElasticsearchMigrationResult
} from '../shared/types'
import type { ElasticsearchExportResume, JsonlImportResume } from './elasticsearch-service'
import { TaskCancelledError } from './task-errors'

interface GoElasticsearchServiceOptions {
  binaryPath?: string
}

interface GoControlFiles {
  progressFile: string
  cancelFile: string
}

interface GoProgress {
  stage?: string
  rows: number
  lines?: number
  skipped?: number
  searchAfter?: unknown[]
}

interface GoResult {
  rows?: number
  skipped?: number
  bytes?: number
  index?: string
  mappingFile?: string
  indexCreated?: boolean
  mappingSource?: string
}

interface GoProcessOutput {
  progress?: GoProgress
  result?: GoResult
}

export class GoElasticsearchService {
  private readonly binaryPath: string

  constructor(options: GoElasticsearchServiceOptions = {}) {
    this.binaryPath = options.binaryPath ?? resolveGoBinaryPath()
    if (!existsSync(this.binaryPath)) {
      throw new Error(`未找到 Go 迁移引擎：${this.binaryPath}，请先运行 npm run build:go`)
    }
  }

  async exportIndex(
    connection: ConnectionConfig,
    request: ElasticsearchExportRequest,
    onProgress?: (processedRows: number, cursor?: unknown) => void,
    resume?: ElasticsearchExportResume
  ): Promise<ElasticsearchMigrationResult> {
    const startedAt = performance.now()
    const control = await createControlFiles(request.outputFile)
    const args = buildExportArgs(connection, request, control, resume)

    try {
      const output = await this.runProcess(args, control, (value) => {
        if (value.stage === 'export' && Array.isArray(value.searchAfter)) {
          onProgress?.(value.rows, value.searchAfter)
        } else {
          onProgress?.(value.rows, value.rows)
        }
      })
      const outputStat = await stat(request.outputFile)
      const result: ElasticsearchMigrationResult = {
        rows: output.result?.rows ?? output.progress?.rows ?? 0,
        bytes: output.result?.bytes ?? outputStat.size,
        durationMs: Math.round(performance.now() - startedAt),
        index: request.index
      }
      if (
        typeof output.result?.mappingFile === 'string' &&
        output.result.mappingFile.length > 0
      ) {
        result.mappingFile = output.result.mappingFile
      }
      return result
    } finally {
      await removeControlFiles(control)
    }
  }

  async importJsonl(
    connection: ConnectionConfig,
    request: ElasticsearchImportRequest,
    onProgress?: (processedRows: number, cursor?: unknown) => void,
    resume?: JsonlImportResume
  ): Promise<ElasticsearchMigrationResult> {
    const startedAt = performance.now()
    const control = await createControlFiles(request.inputFile)
    const args = buildImportArgs(connection, request, control, resume)

    try {
      const output = await this.runProcess(args, control, (value) => {
        onProgress?.(value.rows, value.lines ?? 0)
      })
      const result: ElasticsearchMigrationResult = {
        rows: output.result?.rows ?? output.progress?.rows ?? 0,
        skipped: output.result?.skipped ?? output.progress?.skipped ?? 0,
        durationMs: Math.round(performance.now() - startedAt),
        index: request.index
      }
      if (output.result?.indexCreated === true) {
        result.indexCreated = true
      }
      const usedSidecar = resolveMappingSidecarPath(request)
      if (usedSidecar) {
        result.mappingFile = usedSidecar
      }
      return result
    } finally {
      await removeControlFiles(control)
    }
  }

  private async runProcess(
    args: string[],
    control: GoControlFiles,
    onProgress: (progress: GoProgress) => void
  ): Promise<GoProcessOutput> {
    const child = spawn(this.binaryPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    let stdout = ''
    let latest: GoProgress | undefined
    let cancelledByCallback = false
    let progressTimer: NodeJS.Timeout | undefined

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    const completion = new Promise<number>((resolve, reject) => {
      child.once('error', (error) => {
        reject(error)
      })
      child.once('close', (code, signal) => {
        if (cancelledByCallback) {
          resolve(3)
          return
        }
        if (signal && !cancelledByCallback) {
          reject(new Error(`Go 迁移引擎被信号终止：${signal}`))
          return
        }
        resolve(code ?? 1)
      })
    })

    progressTimer = setInterval(() => {
      void (async () => {
        try {
          const progress = await readProgress(control.progressFile)
          if (progress) {
            latest = progress
            onProgress(progress)
          }
        } catch (cause) {
          if (cause instanceof TaskCancelledError) {
            cancelledByCallback = true
            if (progressTimer) {
              clearInterval(progressTimer)
            }
            await writeFile(control.cancelFile, 'cancel', 'utf8').catch(() => undefined)
            child.kill()
          }
        }
      })()
    }, 500)

    try {
      const exitCode = await completion
      if (exitCode === 3) {
        throw new TaskCancelledError('go-elasticsearch')
      }
      if (exitCode !== 0) {
        throw new Error(stderr.trim() || `Go 迁移引擎退出码：${exitCode}`)
      }
      return {
        progress: latest,
        result: parseGoResult(stdout)
      }
    } finally {
      if (progressTimer) {
        clearInterval(progressTimer)
      }
    }
  }
}

function buildExportArgs(
  connection: ConnectionConfig,
  request: ElasticsearchExportRequest,
  control: GoControlFiles,
  resume?: ElasticsearchExportResume
): string[] {
  const args = [
    'export',
    '--url',
    elasticsearchBaseUrl(connection),
    '--index',
    request.index,
    '--output',
    request.outputFile,
    '--batch-size',
    String(request.batchSize),
    '--strategy',
    request.strategy,
    '--progress-file',
    control.progressFile,
    '--cancel-file',
    control.cancelFile
  ]
  appendAuthArgs(args, connection)
  if (request.query && request.query.trim().length > 0) {
    args.push('--query', request.query.trim())
  }
  if (request.exportMapping === false) {
    args.push('--export-mapping=false')
  }
  if (resume && typeof resume.rows === 'number' && resume.rows > 0) {
    args.push('--resume-rows', String(resume.rows))
  }
  if (resume && Array.isArray(resume.searchAfter)) {
    args.push('--search-after', JSON.stringify(resume.searchAfter))
  }
  return args
}

function buildImportArgs(
  connection: ConnectionConfig,
  request: ElasticsearchImportRequest,
  control: GoControlFiles,
  resume?: JsonlImportResume
): string[] {
  const args = [
    'import',
    '--url',
    elasticsearchBaseUrl(connection),
    '--index',
    request.index,
    '--input',
    request.inputFile,
    '--batch-size',
    String(request.batchSize),
    '--on-conflict',
    request.onConflict,
    '--progress-file',
    control.progressFile,
    '--cancel-file',
    control.cancelFile
  ]
  appendAuthArgs(args, connection)
  if (request.createIndex === false) {
    args.push('--create-index=false')
  }
  if (request.mapping) {
    if (request.mapping.source === 'inline') {
      if (request.mapping.inlineJson && request.mapping.inlineJson.trim().length > 0) {
        args.push('--inline-mapping', request.mapping.inlineJson.trim())
      }
    } else {
      const sidecar = request.mapping.sidecarPath?.trim()
      args.push('--mapping-file', sidecar && sidecar.length > 0 ? sidecar : `${request.inputFile}.mapping.json`)
    }
  }
  if (resume && resume.lines > 0) {
    args.push('--resume-lines', String(resume.lines))
  }
  if (request.selectedColumns && request.selectedColumns.length > 0) {
    args.push('--selected-columns', JSON.stringify(request.selectedColumns))
  }
  if (request.fieldTransforms && request.fieldTransforms.length > 0) {
    args.push('--field-transforms', JSON.stringify(request.fieldTransforms))
  }
  return args
}

function resolveMappingSidecarPath(request: ElasticsearchImportRequest): string | undefined {
  if (!request.mapping) {
    return `${request.inputFile}.mapping.json`
  }
  if (request.mapping.source === 'sidecar') {
    const explicit = request.mapping.sidecarPath?.trim()
    return explicit && explicit.length > 0 ? explicit : `${request.inputFile}.mapping.json`
  }
  return undefined
}

function appendAuthArgs(args: string[], connection: ConnectionConfig): void {
  const username = connection.username?.trim()
  const password = connection.password ?? ''
  if (username) {
    args.push('--username', username)
  }
  if (password) {
    args.push('--password', password)
  }
  if (connection.ssl || elasticsearchBaseUrl(connection).startsWith('https://')) {
    args.push('--insecure-tls')
  }
}

async function createControlFiles(basePath: string): Promise<GoControlFiles> {
  const progressFile = `${basePath}.go-progress.json`
  const cancelFile = `${basePath}.go-cancel`
  await rm(progressFile, { force: true }).catch(() => undefined)
  await rm(cancelFile, { force: true }).catch(() => undefined)
  return { progressFile, cancelFile }
}

async function removeControlFiles(control: GoControlFiles): Promise<void> {
  await Promise.all([
    rm(control.progressFile, { force: true }).catch(() => undefined),
    rm(control.cancelFile, { force: true }).catch(() => undefined)
  ])
}

async function readProgress(path: string): Promise<GoProgress | null> {
  try {
    const data = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(data)
    if (!isRecord(parsed) || typeof parsed.rows !== 'number') {
      return null
    }
    return parsed as unknown as GoProgress
  } catch {
    return null
  }
}

function parseGoResult(stdout: string): GoResult | undefined {
  const lines = stdout
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
  if (lines.length === 0) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(lines[lines.length - 1] ?? '')
    if (isRecord(parsed) && typeof parsed.rows === 'number') {
      return parsed as unknown as GoResult
    }
  } catch {
    // Non-JSON output is not a valid result.
  }
  return undefined
}

function elasticsearchBaseUrl(connection: ConnectionConfig): string {
  const host = connection.host.trim()
  if (/^https?:\/\//i.test(host)) {
    const url = new URL(host)
    if (!url.port && connection.port > 0) {
      url.port = String(connection.port)
    }
    return url.toString().replace(/\/$/, '')
  }
  return `${connection.ssl ? 'https' : 'http'}://${host}:${connection.port}`
}

function resolveGoBinaryPath(): string {
  const binaryName = process.platform === 'win32' ? 'esmigrator.exe' : 'esmigrator'
  const candidates = [
    join(process.resourcesPath, 'go-bin', binaryName),
    join(app.getAppPath(), 'golang', 'esmigrator', 'bin', binaryName),
    join(process.cwd(), 'golang', 'esmigrator', 'bin', binaryName)
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error('未找到 Go 迁移引擎二进制文件')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

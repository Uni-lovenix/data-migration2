import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { finished } from 'node:stream/promises'

import type {
  ConnectionConfig,
  ElasticsearchConflictAction,
  ElasticsearchConnectionTestResult,
  ElasticsearchExportRequest,
  ElasticsearchField,
  ElasticsearchImportRequest,
  ElasticsearchIndex,
  ElasticsearchMigrationResult,
  ElasticsearchReadStrategy
} from '../shared/types'
import { expandJsonlRecord } from '../shared/jsonl-record'
import { transformRecord } from '../shared/type-conversion'
import { TaskCancelledError } from './task-errors'

export interface ElasticsearchExportResume {
  rows?: number
  searchAfter?: unknown[]
}

export interface JsonlImportResume {
  lines: number
  rows: number
}

export interface ElasticsearchHttpRequest {
  method: string
  path: string
  body?: unknown
  rawBody?: string
}

export interface ElasticsearchHttpResult {
  status: number
  body: unknown
  text: string
}

export interface ElasticsearchHttpClient {
  request(request: ElasticsearchHttpRequest): Promise<ElasticsearchHttpResult>
}

export type ElasticsearchHttpClientFactory = (
  connection: ConnectionConfig
) => ElasticsearchHttpClient

interface ElasticsearchHit {
  _id?: unknown
  _routing?: unknown
  _source?: unknown
  sort?: unknown
}

interface ElasticsearchImportRow {
  id?: string
  routing?: string
  source: Record<string, unknown>
}

export class NodeElasticsearchHttpClient implements ElasticsearchHttpClient {
  private readonly connection: ConnectionConfig

  constructor(connection: ConnectionConfig) {
    this.connection = connection
  }

  request(request: ElasticsearchHttpRequest): Promise<ElasticsearchHttpResult> {
    return requestNode(this.connection, request)
  }
}

export class ElasticsearchService {
  private readonly clientFactory: ElasticsearchHttpClientFactory

  constructor(
    clientFactory: ElasticsearchHttpClientFactory = (connection) =>
      new NodeElasticsearchHttpClient(connection)
  ) {
    this.clientFactory = clientFactory
  }

  async testConnection(
    connection: ConnectionConfig
  ): Promise<ElasticsearchConnectionTestResult> {
    try {
      const body = await this.requestJson(connection, 'GET', '/')
      const root = asRecord(body)
      const version = asRecord(root.version)
      const serverVersion =
        typeof version.number === 'string' ? version.number : undefined
      return {
        ok: true,
        serverVersion,
        supported: isSupportedElasticsearchVersion(serverVersion)
      }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }

  async listIndices(connection: ConnectionConfig): Promise<ElasticsearchIndex[]> {
    const [indicesBody, aliasesBody, mappingsBody] = await Promise.all([
      this.requestJson(
        connection,
        'GET',
        '/_cat/indices?format=json&bytes=b&expand_wildcards=open,closed'
      ),
      this.requestJson(connection, 'GET', '/_cat/aliases?format=json'),
      this.requestJson(connection, 'GET', '/_mapping')
    ])

    const aliasesByIndex = collectAliases(aliasesBody)
    const mappings = asRecord(mappingsBody)
    const rows = Array.isArray(indicesBody) ? indicesBody : []
    const indices = rows
      .map((row) => {
        const record = asRecord(row)
        const name = typeof record.index === 'string' ? record.index : ''
        if (name.length === 0) {
          return null
        }
        const indexMapping = asRecord(mappings[name])
        const properties = asRecord(
          asRecord(indexMapping.mappings)?.properties
        )
        return {
          name,
          health: nullableString(record.health),
          status: nullableString(record.status),
          docsCount: nullableNumber(record['docs.count']),
          storeSize: nullableString(record['store.size']),
          aliases: aliasesByIndex.get(name) ?? [],
          fields: flattenMappingProperties(properties)
        }
      })
      .filter((index): index is ElasticsearchIndex => index !== null)

    for (const index of indices) {
      index.fields.sort((left, right) => left.name.localeCompare(right.name))
    }
    return indices
  }

  async exportIndex(
    connection: ConnectionConfig,
    request: ElasticsearchExportRequest,
    onProgress?: (processedRows: number, cursor?: unknown) => void,
    resume?: ElasticsearchExportResume
  ): Promise<ElasticsearchMigrationResult> {
    const startedAt = performance.now()
    const temporaryPath = `${request.outputFile}.part`
    const resumeRows = resume?.rows ?? 0
    const output = createWriteStream(temporaryPath, {
      encoding: 'utf8',
      flags: resumeRows > 0 ? 'a' : 'w'
    })
    let rows = resumeRows

    try {
      await mkdir(dirname(request.outputFile), { recursive: true })
      if (request.strategy === 'search_after') {
        await this.exportWithSearchAfter(
          connection,
          request,
          output,
          (processed, nextCursor) => {
            rows = processed
            onProgress?.(processed, nextCursor)
          },
          resume
        )
      } else {
        await this.exportWithScroll(
          connection,
          request,
          output,
          (processed) => {
            rows = processed
            onProgress?.(processed, processed)
          },
          resumeRows
        )
      }

      output.end()
      await finished(output)
      const bytes = (await stat(temporaryPath)).size
      await rm(request.outputFile, { force: true })
      await rename(temporaryPath, request.outputFile)
      return {
        rows,
        bytes,
        durationMs: performance.now() - startedAt,
        index: request.index
      }
    } catch (error) {
      output.destroy()
      if (!(error instanceof TaskCancelledError)) {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
      }
      throw error
    }
  }

  async importJsonl(
    connection: ConnectionConfig,
    request: ElasticsearchImportRequest,
    onProgress?: (processedRows: number, cursor?: unknown) => void,
    resume?: JsonlImportResume
  ): Promise<ElasticsearchMigrationResult> {
    const startedAt = performance.now()
    let rows = resume?.rows ?? 0
    let skipped = 0

    const input = createReadStream(request.inputFile, { encoding: 'utf8' })
    const lines = createInterface({ input, crlfDelay: Infinity })
    let pending: ElasticsearchImportRow[] = []
    let lineNumber = 0

    for await (const line of lines) {
      lineNumber += 1
      if (resume && lineNumber <= resume.lines) {
        continue
      }
      if (line.trim().length === 0) {
        continue
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new Error(`第 ${lineNumber} 行不是有效 JSON`)
      }
      // Normalize：批次信封 {table, columns, rows} 展开为逐行文档；
      // 逐行记录（PG/ES 导出器的行长）原样透传。
      for (const record of expandJsonlRecord(parsed, lineNumber)) {
        const row = toImportRow(record, lineNumber, request.selectedColumns)
        row.source = transformRecord(
          row.source,
          request.fieldTransforms,
          new Map(),
          lineNumber
        )
        pending.push(row)
      }

      // 只在行边界 flush：批次信封整行必须一次性入库，续传游标（lines）才与已落库数据对齐。
      if (pending.length >= request.batchSize) {
        const batchResult = await this.flushBulk(connection, request, pending)
        rows += pending.length
        skipped += batchResult.skipped
        pending = []
        onProgress?.(rows, lineNumber)
      }
    }

    if (pending.length > 0) {
      const batchResult = await this.flushBulk(connection, request, pending)
      rows += pending.length
      skipped += batchResult.skipped
      onProgress?.(rows, lineNumber)
    }

    return {
      rows,
      skipped,
      durationMs: performance.now() - startedAt,
      index: request.index
    }
  }

  private async exportWithScroll(
    connection: ConnectionConfig,
    request: ElasticsearchExportRequest,
    output: NodeJS.WritableStream,
    onProgress: (processedRows: number) => void,
    resumeRows = 0
  ): Promise<void> {
    let scrollId: string | undefined
    let written = resumeRows
    let skipRemaining = resumeRows
    try {
      let body = await this.requestJson(
        connection,
        'POST',
        `/${encodeURIComponent(request.index)}/_search?scroll=1m`,
        scrollSearchBody(request.batchSize)
      )
      scrollId = scrollIdFrom(body)

      while (true) {
        const hits = extractHits(body)
        if (hits.length === 0) {
          break
        }
        const startIndex = Math.min(skipRemaining, hits.length)
        skipRemaining -= startIndex
        const toWrite = hits.slice(startIndex)
        if (toWrite.length > 0) {
          await writeHits(output, toWrite, () => undefined)
          written += toWrite.length
          onProgress(written)
        }
        if (hits.length < request.batchSize) {
          break
        }
        if (!scrollId) {
          break
        }

        const next = await this.requestJson(
          connection,
          'POST',
          '/_search/scroll',
          { scroll: '1m', scroll_id: scrollId }
        )
        const nextScrollId = scrollIdFrom(next)
        if (nextScrollId) {
          scrollId = nextScrollId
        }
        body = next
      }
    } finally {
      if (scrollId) {
        await this.requestJson(connection, 'DELETE', '/_search/scroll', {
          scroll_id: scrollId
        }).catch(() => undefined)
      }
    }
  }

  private async exportWithSearchAfter(
    connection: ConnectionConfig,
    request: ElasticsearchExportRequest,
    output: NodeJS.WritableStream,
    onProgress: (processedRows: number, cursor?: unknown) => void,
    resume?: ElasticsearchExportResume
  ): Promise<void> {
    const pitBody = await this.requestJson(
      connection,
      'POST',
      `/${encodeURIComponent(request.index)}/_pit?keep_alive=1m`
    )
    let pitId = pitIdFrom(pitBody)
    if (!pitId) {
      throw new Error('无法创建 Elasticsearch 时间点（PIT），请检查版本与索引权限')
    }

    const resumeSearchAfter = Array.isArray(resume?.searchAfter)
      ? resume?.searchAfter
      : undefined
    let searchAfter = resumeSearchAfter
    let written = resume?.rows ?? 0
    let skipRemaining = resumeSearchAfter ? 0 : (resume?.rows ?? 0)
    try {
      while (true) {
        const body: Record<string, unknown> = {
          size: request.batchSize,
          query: { match_all: {} },
          sort: ['_doc'],
          pit: { id: pitId, keep_alive: '1m' }
        }
        if (searchAfter) {
          body.search_after = searchAfter
        }

        const response = await this.requestJson(connection, 'POST', '/_search', body)
        const responsePitId = pitIdFrom(response)
        if (responsePitId) {
          pitId = responsePitId
        }

        const hits = extractHits(response)
        if (hits.length === 0) {
          break
        }
        const startIndex = Math.min(skipRemaining, hits.length)
        skipRemaining -= startIndex
        const toWrite = hits.slice(startIndex)
        if (toWrite.length > 0) {
          await writeHits(output, toWrite, () => undefined)
          written += toWrite.length
        }

        const lastHit = hits[hits.length - 1] as ElasticsearchHit | undefined
        if (!lastHit || !Array.isArray(lastHit.sort) || lastHit.sort.length === 0) {
          throw new Error('search_after 响应缺少排序游标')
        }
        searchAfter = lastHit.sort
        onProgress(written, searchAfter)
        if (hits.length < request.batchSize) {
          break
        }
      }
    } finally {
      if (pitId) {
        await this.requestJson(connection, 'DELETE', '/_pit', { id: pitId }).catch(
          () => undefined
        )
      }
    }
  }

  private async flushBulk(
    connection: ConnectionConfig,
    request: ElasticsearchImportRequest,
    rows: ElasticsearchImportRow[]
  ): Promise<{ skipped: number }> {
    const action = request.onConflict === 'overwrite' ? 'index' : 'create'
    const bodyLines: string[] = []
    for (const row of rows) {
      const meta: Record<string, unknown> = { _index: request.index }
      if (row.id !== undefined) {
        meta._id = row.id
      }
      if (row.routing !== undefined) {
        meta.routing = row.routing
      }
      bodyLines.push(JSON.stringify({ [action]: meta }))
      bodyLines.push(JSON.stringify(row.source))
    }

    const response = await this.requestJson(
      connection,
      'POST',
      '/_bulk',
      undefined,
      `${bodyLines.join('\n')}\n`
    )
    const items = asRecord(response).items
    if (!Array.isArray(items)) {
      throw new Error('bulk 响应缺少 items')
    }

    let skipped = 0
    for (const item of items) {
      const record = asRecord(item)
      const actionResult = asRecord(record[action])
      if (actionResult.error) {
        if (request.onConflict === 'skip' && actionResult.status === 409) {
          skipped += 1
          continue
        }
        throw new Error(bulkErrorMessage(actionResult, action))
      }
    }
    return { skipped }
  }

  private async requestJson(
    connection: ConnectionConfig,
    method: string,
    path: string,
    body?: unknown,
    rawBody?: string
  ): Promise<unknown> {
    const client = this.clientFactory(connection)
    const result = await client.request({ method, path, body, rawBody })
    if (result.status < 200 || result.status >= 300) {
      throw new Error(errorMessageFromHttpResult(result))
    }
    return result.body
  }
}

function requestNode(
  connection: ConnectionConfig,
  request: ElasticsearchHttpRequest
): Promise<ElasticsearchHttpResult> {
  const url = resolveUrl(connection, request.path)
  const headers: Record<string, string> = {
    accept: 'application/json'
  }
  let payload: string | undefined
  if (request.rawBody !== undefined) {
    headers['content-type'] = 'application/x-ndjson'
    payload = request.rawBody
  } else if (request.body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(request.body)
  }
  if (payload !== undefined) {
    headers['content-length'] = String(Buffer.byteLength(payload))
  }

  const username = connection.username?.trim()
  const password = connection.password ?? ''
  if (username) {
    headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  }

  const transport = url.protocol === 'https:' ? https : http
  const options: http.RequestOptions & { rejectUnauthorized?: boolean } = {
    method: request.method,
    headers,
    timeout: 120_000
  }
  if (connection.ssl || url.protocol === 'https:') {
    options.rejectUnauthorized = false
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(url, options, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        chunks.push(Buffer.from(chunk))
      })
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: unknown = text
        try {
          body = text.length === 0 ? undefined : JSON.parse(text)
        } catch {
          // Keep the raw text for non-JSON responses.
        }
        resolve({
          status: response.statusCode ?? 0,
          body,
          text
        })
      })
    })
    req.on('timeout', () => {
      req.destroy(new Error('Elasticsearch 请求超时'))
    })
    req.on('error', reject)
    if (payload !== undefined) {
      req.write(payload)
    }
    req.end()
  })
}

function resolveUrl(connection: ConnectionConfig, path: string): URL {
  const base = new URL(baseUrlFor(connection))
  const [pathname, query = ''] = path.split('?')
  base.pathname = `${base.pathname.replace(/\/$/, '')}${pathname}`
  if (query) {
    base.search = `?${query}`
  }
  return base
}

function baseUrlFor(connection: ConnectionConfig): string {
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

function scrollSearchBody(batchSize: number): Record<string, unknown> {
  return {
    size: batchSize,
    query: { match_all: {} },
    sort: ['_doc']
  }
}

function writeHits(
  output: NodeJS.WritableStream,
  hits: unknown[],
  onRow: () => void
): Promise<void> {
  return (async () => {
    for (const hit of hits) {
      const line = `${JSON.stringify(serializeHit(hit))}\n`
      if (!output.write(line)) {
        await once(output, 'drain')
      }
      onRow()
    }
  })()
}

function serializeHit(hit: unknown): Record<string, unknown> {
  const record = asRecord(hit)
  const source = asRecord(record._source)
  const line: Record<string, unknown> = {
    _source: source
  }
  if (typeof record._id === 'string' && record._id.length > 0) {
    line._id = record._id
  }
  if (typeof record._routing === 'string') {
    line._routing = record._routing
  }
  return line
}

function extractHits(body: unknown): unknown[] {
  const hits = asRecord(asRecord(body).hits)
  return Array.isArray(hits.hits) ? hits.hits : []
}

function scrollIdFrom(body: unknown): string | undefined {
  const value = asRecord(body)._scroll_id
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function pitIdFrom(body: unknown): string | undefined {
  const record = asRecord(body)
  const value = record.pit_id ?? record.id
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function toImportRow(
  value: unknown,
  lineNumber: number,
  selectedColumns?: string[]
): ElasticsearchImportRow {
  if (!isRecord(value)) {
    throw new Error(`第 ${lineNumber} 行必须是 JSON 对象`)
  }

  if (Object.prototype.hasOwnProperty.call(value, '_source')) {
    const source = value._source
    if (!isRecord(source)) {
      throw new Error(`第 ${lineNumber} 行的 _source 必须是 JSON 对象`)
    }
    return {
      id: optionalString(value._id),
      routing: optionalString(value._routing),
      source: projectElasticsearchSource(source, selectedColumns, lineNumber)
    }
  }

  const source = { ...value }
  const id = optionalString(source._id)
  const routing = optionalString(source._routing)
  delete source._id
  delete source._index
  delete source._type
  delete source._routing
  return {
    id,
    routing,
    source: projectElasticsearchSource(source, selectedColumns, lineNumber)
  }
}

function projectElasticsearchSource(
  source: Record<string, unknown>,
  selectedColumns: string[] | undefined,
  lineNumber: number
): Record<string, unknown> {
  if (!selectedColumns || selectedColumns.length === 0) {
    return source
  }
  const missing = selectedColumns.filter(
    (column) => !Object.prototype.hasOwnProperty.call(source, column)
  )
  if (missing.length > 0) {
    throw new Error(`第 ${lineNumber} 行缺少 selectedColumns：${missing.join(', ')}`)
  }
  const projected: Record<string, unknown> = {}
  for (const column of selectedColumns) {
    projected[column] = source[column]
  }
  return projected
}

function collectAliases(body: unknown): Map<string, string[]> {
  const aliasesByIndex = new Map<string, string[]>()
  if (!Array.isArray(body)) {
    return aliasesByIndex
  }
  for (const item of body) {
    const record = asRecord(item)
    const index = typeof record.index === 'string' ? record.index : ''
    const alias = typeof record.alias === 'string' ? record.alias : ''
    if (index.length > 0 && alias.length > 0) {
      const aliases = aliasesByIndex.get(index) ?? []
      aliases.push(alias)
      aliasesByIndex.set(index, aliases)
    }
  }
  return aliasesByIndex
}

function flattenMappingProperties(
  properties: unknown,
  prefix = ''
): ElasticsearchField[] {
  const fields: ElasticsearchField[] = []
  if (!isRecord(properties)) {
    return fields
  }

  for (const [key, value] of Object.entries(properties)) {
    const record = asRecord(value)
    const name = prefix ? `${prefix}.${key}` : key
    const type = typeof record.type === 'string' ? record.type : 'object'
    if (record.type === 'object' || record.type === 'nested') {
      fields.push({ name, type })
      fields.push(...flattenMappingProperties(record.properties, name))
    } else {
      fields.push({ name, type })
      fields.push(...flattenMappingProperties(record.fields, name))
    }
  }
  return fields
}

function isSupportedElasticsearchVersion(version: string | undefined): boolean {
  if (!version) {
    return false
  }
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) {
    return false
  }
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  return major > 7 || (major === 7 && minor > 10) || (major === 7 && minor === 10 && patch >= 2)
}

function bulkErrorMessage(
  actionResult: Record<string, unknown>,
  action: string
): string {
  const error = asRecord(actionResult.error)
  const reason =
    (typeof error.reason === 'string' ? error.reason : undefined) ??
    (typeof error.type === 'string' ? error.type : undefined) ??
    'bulk 写入失败'
  return `${action} 操作失败：${reason}（HTTP ${String(actionResult.status ?? '')}）`
}

function errorMessageFromHttpResult(result: ElasticsearchHttpResult): string {
  const body = asRecord(result.body)
  const error = body.error
  if (typeof error === 'string') {
    return error
  }
  if (isRecord(error)) {
    return (
      (typeof error.reason === 'string' ? error.reason : undefined) ??
      (typeof error.type === 'string' ? error.type : undefined) ??
      `Elasticsearch 请求失败（HTTP ${result.status}）`
    )
  }
  return result.text || `Elasticsearch 请求失败（HTTP ${result.status}）`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Elasticsearch 操作失败'
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

export function toReadStrategyLabel(strategy: ElasticsearchReadStrategy): string {
  return strategy === 'scroll' ? 'scroll' : 'search_after'
}

export function toConflictActionLabel(action: ElasticsearchConflictAction): string {
  return action === 'overwrite' ? '覆盖' : '跳过'
}

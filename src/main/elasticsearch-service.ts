import { once } from 'node:events'
import { createHash } from 'node:crypto'
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
  ElasticsearchDirectRequest,
  ElasticsearchDirectResult,
  ElasticsearchExportRequest,
  ElasticsearchField,
  ElasticsearchImportRequest,
  ElasticsearchIndex,
  ElasticsearchMigrationResult,
  ElasticsearchReadStrategy,
  RollbackConflictPolicy,
  RollbackResult
} from '../shared/types'
import { expandJsonlRecord } from '../shared/jsonl-record'
import { transformRecord } from '../shared/type-conversion'
import { RollbackConflictError, TaskCancelledError } from './task-errors'
import {
  UndoJournal,
  readUndoJournal,
  type UndoDocEntry
} from './undo-journal'

export interface ElasticsearchDirectControl {
  taskId: string
  /** 撤销日志文件路径（本地控制文件，不是数据文件）。 */
  journalPath: string
}

export interface ElasticsearchRollbackOptions {
  taskId: string
  journalPath: string
  conflictPolicy: RollbackConflictPolicy
}

/** 批次内的单个文档计划：`source` 只存在于内存，不写入撤销日志。 */
interface DirectDocPlan extends UndoDocEntry {
  source: Record<string, unknown>
}

export interface ElasticsearchExportResume {
  rows?: number
  searchAfter?: unknown[]
  cursor?: unknown
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

  async previewIndex(
    connection: ConnectionConfig,
    index: string,
    limit: number
  ): Promise<Array<Record<string, unknown>>> {
    const body = await this.requestJson(
      connection,
      'POST',
      `/${encodeURIComponent(index)}/_search`,
      {
        size: Math.max(1, Math.min(limit, 1000)),
        query: { match_all: {} },
        sort: ['_doc']
      }
    )
    return extractHits(body).map((hit) => asRecord(asRecord(hit)._source))
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
          sort: ['_shard_doc'],
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

  /**
   * Elasticsearch 直连迁移：源索引流式读取，按批次 bulk 直接写入目标索引。
   *
   * 目标端没有事务，写入本身即提交，因此撤销日志采用"写前 pending 计划 +
   * 写后结果记录"两段式：崩溃时无结果的批次视为状态未知，回滚按冲突处理，
   * 不会误删无法确认来源的文档。
   */
  async directMigrateIndex(
    source: ConnectionConfig,
    target: ConnectionConfig,
    request: ElasticsearchDirectRequest,
    control: ElasticsearchDirectControl,
    onProgress?: (processedRows: number, cursor?: unknown) => void
  ): Promise<ElasticsearchDirectResult> {
    const startedAt = performance.now()
    const captureUndo = request.rollbackOn !== 'none'
    const action = request.conflictPolicy === 'overwrite' ? 'index' : 'create'
    let written = 0
    let skipped = 0
    let processed = 0
    let sequence = 0
    const journal = captureUndo
      ? new UndoJournal(control.journalPath, control.taskId)
      : undefined

    const targetInfo = await this.requestRaw(
      target,
      'HEAD',
      `/${encodeURIComponent(request.targetIndex)}`
    )
    if (targetInfo.status === 404) {
      throw new Error(`目标索引不存在：${request.targetIndex}`)
    }
    if (targetInfo.status < 200 || targetInfo.status >= 300) {
      throw new Error(errorMessageFromHttpResult(targetInfo))
    }

    if (journal) {
      await journal.open()
    }

    try {
      await this.forEachSourceBatch(source, request, async (hits) => {
        sequence += 1
        const plans = hits.map((hit) => hitToPlan(hit))
        if (request.conflictPolicy === 'overwrite' && captureUndo) {
          await this.fillPreImages(target, request.targetIndex, plans)
        }
        if (journal) {
          await journal.recordPendingBatch({
            engine: 'elasticsearch',
            sequence,
            mode: request.conflictPolicy === 'overwrite' ? 'overwrite' : 'insert',
            target: { schema: '', name: request.targetIndex },
            keyFields: ['_id'],
            keys: [],
            docs: plans.map((plan) => stripSource(plan)),
            capturedAt: new Date().toISOString()
          })
        }

        const batchResult = await this.bulkWrite(
          target,
          request.targetIndex,
          action,
          plans
        )
        if (journal) {
          await journal.recordBatchResult({
            sequence,
            written: batchResult.written,
            skipped: batchResult.skipped,
            docs: batchResult.docs
          })
        }
        written += batchResult.written
        skipped += batchResult.skipped
        processed += hits.length
        onProgress?.(processed, { rows: processed })
      })
    } finally {
      await journal?.close()
    }

    return {
      rows: written,
      skipped,
      durationMs: performance.now() - startedAt,
      index: request.index,
      targetIndex: request.targetIndex,
      ...(journal ? { undoJournalPath: journal.path } : {})
    }
  }

  /**
   * 回滚一次 Elasticsearch 直连迁移：逆序重放撤销日志，
   * 删除本次写入的文档、恢复被覆盖的文档。条件写使用写入时记录的
   * `_seq_no` / `_primary_term`，第三方修改会让操作以 409 失败。
   */
  async rollbackDirectMigration(
    target: ConnectionConfig,
    request: ElasticsearchRollbackOptions,
    onProgress?: (processedBatches: number, cursor?: unknown) => void
  ): Promise<RollbackResult> {
    const startedAt = performance.now()
    const contents = await readUndoJournal(request.journalPath)
    const batches = [...contents.batches]
      .filter((batch) => batch.engine === 'elasticsearch')
      .sort((a, b) => b.sequence - a.sequence)
    let deletedRows = 0
    let restoredRows = 0
    let skippedConflicts = 0

    // 回滚前先刷新一遍涉及的索引：刚 bulk 写入的文档在 refresh 之前
    // 对 _mget 不可见，不刷新会把"还没可见"误判成"被第三方修改"。
    const involved = new Set(batches.map((batch) => batch.target.name))
    for (const index of involved) {
      await this.requestJson(target, 'POST', `/${encodeURIComponent(index)}/_refresh`).catch(
        () => undefined
      )
    }

    // abort 策略先只读预检：任何冲突或状态未知的批次都让整体回滚中止。
    if (request.conflictPolicy !== 'skip') {
      for (const batch of batches) {
        const result = contents.results.get(batch.sequence)
        if (!result) {
          throw new RollbackConflictError(
            (batch.docs ?? []).length || 1,
            `索引 ${batch.target.name}（批次 ${batch.sequence} 状态未知）`
          )
        }
        const docs = result.docs.filter((doc) => doc.state === 'written')
        const conflicts = await this.countDocConflicts(target, batch.target.name, docs)
        if (conflicts > 0) {
          throw new RollbackConflictError(conflicts, `索引 ${batch.target.name}`)
        }
      }
    }

    let processedBatches = 0
    for (const batch of batches) {
      const result = contents.results.get(batch.sequence)
      if (!result) {
        skippedConflicts += (batch.docs ?? []).length
        processedBatches += 1
        onProgress?.(processedBatches, { batches: processedBatches })
        continue
      }
      const docs = result.docs.filter((doc) => doc.state === 'written')
      if (docs.length === 0) {
        processedBatches += 1
        onProgress?.(processedBatches, { batches: processedBatches })
        continue
      }
      const batchResult = await this.bulkRollback(target, batch.target.name, docs)
      deletedRows += batchResult.deleted
      restoredRows += batchResult.restored
      skippedConflicts += batchResult.conflicts
      processedBatches += 1
      onProgress?.(processedBatches, { batches: processedBatches })
    }

    return {
      taskId: request.taskId,
      deletedRows,
      restoredRows,
      skippedConflicts,
      durationMs: performance.now() - startedAt
    }
  }

  /** 读取源索引，逐批回调（scroll 或 search_after）。 */
  private async forEachSourceBatch(
    connection: ConnectionConfig,
    request: ElasticsearchDirectRequest,
    onBatch: (hits: unknown[]) => Promise<void>
  ): Promise<void> {
    if (request.strategy === 'search_after') {
      await this.forEachSearchAfterBatch(connection, request, onBatch)
      return
    }
    await this.forEachScrollBatch(connection, request, onBatch)
  }

  private async forEachScrollBatch(
    connection: ConnectionConfig,
    request: ElasticsearchDirectRequest,
    onBatch: (hits: unknown[]) => Promise<void>
  ): Promise<void> {
    const query = parseDirectQuery(request.query)
    let scrollId: string | undefined
    try {
      let body = await this.requestJson(
        connection,
        'POST',
        `/${encodeURIComponent(request.index)}/_search?scroll=1m`,
        { size: request.batchSize, sort: ['_doc'], ...(query ? { query } : { query: { match_all: {} } }) }
      )
      scrollId = scrollIdFrom(body)
      while (true) {
        const hits = extractHits(body)
        if (hits.length === 0) {
          break
        }
        await onBatch(hits)
        if (hits.length < request.batchSize || !scrollId) {
          break
        }
        const next = await this.requestJson(connection, 'POST', '/_search/scroll', {
          scroll: '1m',
          scroll_id: scrollId
        })
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

  private async forEachSearchAfterBatch(
    connection: ConnectionConfig,
    request: ElasticsearchDirectRequest,
    onBatch: (hits: unknown[]) => Promise<void>
  ): Promise<void> {
    const query = parseDirectQuery(request.query)
    const pitBody = await this.requestJson(
      connection,
      'POST',
      `/${encodeURIComponent(request.index)}/_pit?keep_alive=1m`
    )
    let pitId = pitIdFrom(pitBody)
    if (!pitId) {
      throw new Error('无法创建 Elasticsearch 时间点（PIT），请检查版本与索引权限')
    }
    let searchAfter: unknown[] | undefined
    try {
      while (true) {
        const body: Record<string, unknown> = {
          size: request.batchSize,
          sort: ['_shard_doc'],
          pit: { id: pitId, keep_alive: '1m' },
          ...(query ? { query } : { query: { match_all: {} } })
        }
        if (searchAfter) {
          body.search_after = searchAfter
        }
        const response = await this.requestJson(connection, 'POST', '/_search', body)
        const nextPit = pitIdFrom(response)
        if (nextPit) {
          pitId = nextPit
        }
        const hits = extractHits(response)
        if (hits.length === 0) {
          break
        }
        await onBatch(hits)
        const last = asRecord(hits[hits.length - 1])
        const sort = last.sort
        searchAfter = Array.isArray(sort) ? sort : undefined
        if (hits.length < request.batchSize || !searchAfter) {
          break
        }
      }
    } finally {
      await this.requestJson(connection, 'DELETE', '/_pit', { id: pitId }).catch(
        () => undefined
      )
    }
  }

  /** 覆盖写模式：写入前取目标文档的前映像与 seq_no/primary_term。 */
  private async fillPreImages(
    target: ConnectionConfig,
    index: string,
    plans: DirectDocPlan[]
  ): Promise<void> {
    const response = await this.requestJson(
      target,
      'POST',
      `/${encodeURIComponent(index)}/_mget`,
      {
        docs: plans.map((plan) => ({
          _id: plan.id,
          ...(plan.routing ? { routing: plan.routing } : {})
        }))
      }
    )
    const docs = asRecord(response).docs
    if (!Array.isArray(docs)) {
      return
    }
    docs.forEach((raw, position) => {
      const doc = asRecord(raw)
      const plan = plans[position]
      if (!plan || doc.found !== true) {
        return
      }
      plan.preImage = asRecord(doc._source) as Record<string, unknown>
      plan.preSeqNo = nullableNumber(doc._seq_no)
      plan.prePrimaryTerm = nullableNumber(doc._primary_term)
    })
  }

/** 直连批量写入；只把目标端确认写入的文档记为"本次写入"。 */
  private async bulkWrite(
    target: ConnectionConfig,
    index: string,
    action: 'create' | 'index',
    plans: DirectDocPlan[]
  ): Promise<{ written: number; skipped: number; docs: UndoDocEntry[] }> {
    const lines: string[] = []
    for (const plan of plans) {
      const meta: Record<string, unknown> = { _index: index, _id: plan.id }
      if (plan.routing) {
        meta.routing = plan.routing
      }
      lines.push(JSON.stringify({ [action]: meta }))
      lines.push(JSON.stringify(plan.source))
    }
    const response = await this.requestJson(
      target,
      'POST',
      '/_bulk',
      undefined,
      `${lines.join('\n')}\n`
    )
    const items = asRecord(response).items
    if (!Array.isArray(items)) {
      throw new Error('bulk 响应缺少 items')
    }

    let written = 0
    let skipped = 0
    const docs: UndoDocEntry[] = []
    items.forEach((item, position) => {
      const plan = plans[position]
      if (!plan) {
        return
      }
      const actionResult = asRecord(asRecord(item)[action])
      const status = nullableNumber(actionResult.status) ?? 0
      if (action === 'create' && status === 409) {
        skipped += 1
        docs.push({
          ...stripSource(plan),
          state: 'skipped',
          rowHash: null,
          seqNo: null,
          primaryTerm: null
        })
        return
      }
      if (actionResult.error || status >= 400) {
        throw new Error(bulkErrorMessage(actionResult, action))
      }
      written += 1
      docs.push({
        ...stripSource(plan),
        state: 'written',
        rowHash: hashSource(plan.source),
        seqNo: nullableNumber(actionResult._seq_no),
        primaryTerm: nullableNumber(actionResult._primary_term)
      })
    })
    return { written, skipped, docs }
  }

  /** 统计"本次写入后又被改动/删除"的文档数（abort 预检用）。 */
  private async countDocConflicts(
    target: ConnectionConfig,
    index: string,
    docs: UndoDocEntry[]
  ): Promise<number> {
    if (docs.length === 0) {
      return 0
    }
    const response = await this.requestJson(
      target,
      'POST',
      `/${encodeURIComponent(index)}/_mget`,
      {
        docs: docs.map((doc) => ({
          _id: doc.id,
          ...(doc.routing ? { routing: doc.routing } : {})
        }))
      }
    )
    const found = asRecord(response).docs
    if (!Array.isArray(found)) {
      return 0
    }
    let conflicts = 0
    found.forEach((raw, position) => {
      const doc = asRecord(raw)
      const plan = docs[position]
      if (!plan) {
        return
      }
      if (doc.found !== true) {
        // 文档已经不存在：可能是上一次回滚删掉的（幂等重跑），
        // 也可能是第三方删除的。两种情况都不需要再动它，不算冲突。
        return
      }
      if (
        nullableNumber(doc._seq_no) !== (plan.seqNo ?? null) ||
        nullableNumber(doc._primary_term) !== (plan.primaryTerm ?? null)
      ) {
        conflicts += 1
      }
    })
    return conflicts
  }

  /** 回滚一个批次：新增文档删除、覆盖文档恢复前映像，均带 seq 守卫。 */
  private async bulkRollback(
    target: ConnectionConfig,
    index: string,
    docs: UndoDocEntry[]
  ): Promise<{ deleted: number; restored: number; conflicts: number }> {
    const lines: string[] = []
    const actions: string[] = []
    for (const doc of docs) {
      const guards: Record<string, unknown> = {}
      if (doc.seqNo !== null && doc.seqNo !== undefined) {
        guards.if_seq_no = doc.seqNo
        guards.if_primary_term = doc.primaryTerm ?? 1
      }
      const meta: Record<string, unknown> = { _index: index, _id: doc.id, ...guards }
      if (doc.routing) {
        meta.routing = doc.routing
      }
      if (doc.preImage) {
        lines.push(JSON.stringify({ index: meta }))
        lines.push(JSON.stringify(doc.preImage))
        actions.push('index')
      } else {
        lines.push(JSON.stringify({ delete: meta }))
        actions.push('delete')
      }
    }
    if (lines.length === 0) {
      return { deleted: 0, restored: 0, conflicts: 0 }
    }

    const response = await this.requestJson(
      target,
      'POST',
      '/_bulk',
      undefined,
      `${lines.join('\n')}\n`
    )
    const items = asRecord(response).items
    if (!Array.isArray(items)) {
      throw new Error('bulk 响应缺少 items')
    }

    let deleted = 0
    let restored = 0
    let conflicts = 0
    for (const [position, item] of items.entries()) {
      const action = actions[position] ?? 'delete'
      const actionResult = asRecord(asRecord(item)[action])
      const status = nullableNumber(actionResult.status) ?? 0
      if (status === 404) {
        // 文档已不存在（上次回滚已删或第三方删除），视为已完成。
        continue
      }
      if (status === 409) {
        conflicts += 1
        continue
      }
      if (actionResult.error || status >= 400) {
        throw new Error(bulkErrorMessage(actionResult, action))
      }
      if (action === 'delete') {
        deleted += 1
      } else {
        restored += 1
      }
    }
    return { deleted, restored, conflicts }
  }

  /** 不带抛错的原始请求（用于 HEAD 探测等需要看状态码的场景）。 */
  private async requestRaw(
    connection: ConnectionConfig,
    method: string,
    path: string
  ): Promise<ElasticsearchHttpResult> {
    return this.clientFactory(connection).request({ method, path })
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

/** 把搜索命中转成直连写入计划（source 只驻留内存）。 */
function hitToPlan(hit: unknown): DirectDocPlan {
  const record = asRecord(hit)
  const id = record._id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('源索引命中缺少 _id，无法建立回滚记录')
  }
  const routing = record._routing
  return {
    id,
    routing: typeof routing === 'string' && routing.length > 0 ? routing : null,
    state: 'pending',
    rowHash: null,
    seqNo: null,
    primaryTerm: null,
    preImage: null,
    preSeqNo: null,
    prePrimaryTerm: null,
    source: asRecord(record._source) as Record<string, unknown>
  }
}

function stripSource(plan: DirectDocPlan): UndoDocEntry {
  const { source: _source, ...entry } = plan
  return entry
}

function hashSource(source: Record<string, unknown>): string {
  return createHash('md5').update(JSON.stringify(source)).digest('hex')
}

/** 直连迁移的查询体：留空时匹配全部。 */
function parseDirectQuery(query: string | undefined): unknown | undefined {
  if (typeof query !== 'string' || query.trim().length === 0) {
    return undefined
  }
  const parsed = JSON.parse(query) as unknown
  return parsed
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

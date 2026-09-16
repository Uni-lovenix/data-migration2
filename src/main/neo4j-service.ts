import { once } from 'node:events'
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, truncate } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { finished } from 'node:stream/promises'

import neo4j, { type Driver, type Session } from 'neo4j-driver'

import type {
  ConnectionConfig,
  Neo4jBatchExportRequest,
  Neo4jBatchMigrationResult,
  Neo4jConnectionTestResult,
  Neo4jCountNodesRequest,
  Neo4jCountRelationshipsRequest,
  Neo4jExportRequest,
  Neo4jMigrationResult,
  Neo4jTable,
  Neo4jTableKind
} from '../shared/types'
import { TaskCancelledError } from './task-errors'

/**
 * Neo4jService —— 数据转换引擎的 **Neo4j Source Connector**（Node.js 侧）。
 *
 * 引擎位置：
 *
 *     Neo4j (Bolt) ──> [本 Connector: Source + Normalize] ──> JSONL 信封（磁盘）
 *                                                                   │
 *                                       ES / PG / MySQL / Hive Sink ◀┘
 *
 * 本 Connector 只负责 Source + Normalize 两段，不做业务级类型映射（Transform 层职责）：
 *
 *   1. **Source**：Cypher 流式读取节点/关系（`SKIP $offset LIMIT $batch` 支持断点续传），
 *      节点与关系分别为两种查询形状。
 *   2. **Normalize**：`normalizeNeo4jValue` 把驱动返回的复杂类型统一归一化为 JSON 兼容值：
 *      - Temporal（Date / DateTime / LocalDateTime / Time / LocalTime / Duration）→ ISO 字符串；
 *      - Spatial（Point）→ `{x, y, z, srid}`；
 *      - Node → `{_id, _labels, properties}`；Relationship → `{_id, _type, _src, _dst, properties}`；
 *      - 驱动 Integer → JS number；
 *      - 其它对象 → 递归归一化（默认 JSON 兜底）。
 *   3. **Sink 中性**：每个节点/关系写一行 JSON 对象：
 *      - Node：`{_id, _labels, properties}`
 *      - Relationship：`{_id, _type, _src, _dst, properties}`
 *      可直接作为 Elasticsearch bulk source / PostgreSQL JSONL 记录消费。
 *
 * 续传协议（与 PG/MySQL Connector 一致）：
 *   - 写入 `<outputFile>.part`，全部成功后才 `rename` 为 `<outputFile>`；
 *   - `.part` 中已完整落盘信封的行数即 resume 起点，与调用方传入的 `resumeRows` 取较大值；
 *   - 上一轮中断留下的半行信封（不可解析）在续传时截断丢弃，已落盘的行全部保留。
 *
 * 取消协议（与 PG/MySQL Connector 一致）：
 *   - 驱动侧报出的取消类错误（cancel / terminate / interrupt）归一化为 `TaskCancelledError`
 *     并保留 `.part`，使任务可续传；其它错误视为失败，丢弃 `.part`。
 */

// ============================================================
// 驱动抽象（测试注入 FakeDriver；生产注入 neo4j-driver）
// ============================================================

/** 单条记录的字段读取契约：显式 `get(key)` 或普通对象属性。 */
export interface Neo4jResultLike {
  records: AsyncIterable<Record<string, unknown>>
}

export interface Neo4jSessionLike {
  run(cypher: string, params?: Record<string, unknown>): Promise<Neo4jResultLike>
  close(): Promise<void> | void
}

export interface Neo4jServiceDriverLike {
  session(config?: { database?: string }): Neo4jSessionLike
  close(): Promise<void> | void
}

export type Neo4jServiceDriverFactory = (connection: ConnectionConfig) => Neo4jServiceDriverLike

export interface Neo4jBatchExportCursor {
  tableIndex: number
  rows: number
}

const LABELS_QUERY = 'CALL db.labels() YIELD label RETURN label ORDER BY label'
const RELATIONSHIP_TYPES_QUERY =
  'CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType'

const TEMPORAL_TYPE_NAMES = new Set([
  'Date',
  'DateTime',
  'LocalDateTime',
  'Time',
  'LocalTime',
  'Duration'
])

export class Neo4jService {
  private readonly factory: Neo4jServiceDriverFactory

  constructor(factory?: Neo4jServiceDriverFactory) {
    this.factory = factory ?? defaultDriverFactory
  }

  // ============================================================
  // Connection
  // ============================================================

  async testConnection(connection: ConnectionConfig): Promise<Neo4jConnectionTestResult> {
    try {
      const driver = this.factory(connection)
      try {
        const session = driver.session(sessionConfig(connection))
        try {
          const result = await session.run(
            'CALL dbms.components() YIELD name, versions, edition RETURN name, versions, edition'
          )
          const record = await firstRecord(result)
          // 产品族名（'Neo4j Kernel' → 'Neo4j'）：UI 展示 `已连接 Neo4j`
          return { ok: true, serverVersion: productFamilyName(toText(readField(record, 'name'))) }
        } finally {
          await session.close()
        }
      } finally {
        await driver.close()
      }
    } catch (error) {
      return { ok: false, message: classifyNeo4jError(error) }
    }
  }

  // ============================================================
  // Schema discovery（来源：图目录，非 information_schema）
  // ============================================================

  /**
   * 列出可导出的「表」：节点标签 + 关系类型。
   *
   * 注意：一个 session 只跑一条查询（标签与关系类型各一个 session）。
   * 属性列不在此处采样 —— 图 schema 是隐式的，列集合由每个信封在写入时确定
   * （`_id` / `_labels` / `properties` 或 `_id` / `_type` / `_src` / `_dst` / `properties`）。
   */
  async listTables(connection: ConnectionConfig): Promise<Neo4jTable[]> {
    const labels = await this.listLabels(connection)
    const relationshipTypes = await this.listRelationshipTypes(connection)
    const tables: Neo4jTable[] = []
    for (const label of labels) {
      tables.push({
        kind: 'node',
        name: label,
        columns: [],
        estimatedRows: null,
        partitionColumns: []
      })
    }
    for (const type of relationshipTypes) {
      tables.push({
        kind: 'relationship',
        name: type,
        columns: [],
        estimatedRows: null,
        partitionColumns: []
      })
    }
    return tables
  }

  async listLabels(connection: ConnectionConfig): Promise<string[]> {
    const driver = this.factory(connection)
    try {
      return await collectStrings(driver, connection, LABELS_QUERY, (record) =>
        toText(readField(record, 'label'))
      )
    } finally {
      await driver.close()
    }
  }

  async listRelationshipTypes(connection: ConnectionConfig): Promise<string[]> {
    const driver = this.factory(connection)
    try {
      return await collectStrings(driver, connection, RELATIONSHIP_TYPES_QUERY, (record) =>
        toText(readField(record, 'relationshipType'))
      )
    } finally {
      await driver.close()
    }
  }

  async countNodes(connection: ConnectionConfig, request: Neo4jCountNodesRequest): Promise<number> {
    return this.count(
      connection,
      `MATCH (n:\`${escapeBackticks(request.label)}\`) RETURN count(n) AS count`
    )
  }

  async countRelationships(
    connection: ConnectionConfig,
    request: Neo4jCountRelationshipsRequest
  ): Promise<number> {
    return this.count(
      connection,
      `MATCH ()-[r:\`${escapeBackticks(request.type)}\`]->() RETURN count(r) AS count`
    )
  }

  private async count(connection: ConnectionConfig, cypher: string): Promise<number> {
    const driver = this.factory(connection)
    try {
      const session = driver.session(sessionConfig(connection))
      try {
        const result = await session.run(cypher)
        const record = await firstRecord(result)
        return toNumber(readField(record, 'count'))
      } finally {
        await session.close()
      }
    } finally {
      await driver.close()
    }
  }

  // ============================================================
  // Export（Source + Normalize → JSONL 信封）
  // ============================================================

  async exportTable(
    connection: ConnectionConfig,
    request: Neo4jExportRequest,
    onProgress?: (rows: number) => void,
    resumeRows = 0
  ): Promise<Neo4jMigrationResult> {
    const startedAt = Date.now()
    const partFile = `${request.outputFile}.part`

    await mkdir(dirname(request.outputFile), { recursive: true })
    const part = await readPartState(partFile)
    if (part.incompleteBytes > 0) {
      // 上一轮中断留下的半行信封不可解析；截断到最后一条完整信封，保留已落盘的行
      await truncate(partFile, part.size - part.incompleteBytes)
    }
    const startOffset = Math.max(resumeRows, part.rows)
    let written = startOffset

    const output = createWriteStream(partFile, { encoding: 'utf8', flags: 'a' })
    // 磁盘类错误必须被捕获，否则 'error' 事件无人监听 → 未捕获异常（主进程崩溃）
    let streamFailure: Error | null = null
    output.on('error', (error: Error) => {
      streamFailure = streamFailure ?? error
    })
    try {
      await this.streamRows(connection, request, startOffset, request.batchSize, async (row) => {
        const chunk = `${JSON.stringify(row)}\n`
        if (!output.write(chunk)) {
          await once(output, 'drain')
        }
        written += 1
        onProgress?.(written)
      })
      if (streamFailure) {
        throw streamFailure
      }
      output.end()
      await finished(output)
    } catch (error) {
      output.destroy()
      // `createWriteStream` 是**异步 open**：必须等 fd 生命周期结束再决定保留/删除，
      // 否则会出现两种不确定行为 —— 取消后 `.part` 根本不存在（丢失续传起点）、
      // 硬失败后残留 0 字节 `.part`（下次续传把它当成合法断点）。
      await settleWriteStream(output)
      const mapped = mapExportError(error ?? streamFailure, request, written)
      if (!(mapped instanceof TaskCancelledError)) {
        await rm(partFile, { force: true }).catch(() => undefined)
      }
      throw mapped
    }

    await rm(request.outputFile, { force: true })
    await rename(partFile, request.outputFile)
    const bytes = (await stat(request.outputFile)).size
    return {
      rows: written,
      bytes,
      durationMs: Date.now() - startedAt,
      table: { kind: request.kind, name: request.name }
    }
  }

  async exportTables(
    connection: ConnectionConfig,
    request: Neo4jBatchExportRequest,
    onProgress?: (rows: number, cursor?: Neo4jBatchExportCursor) => void,
    resume?: Neo4jBatchExportCursor
  ): Promise<Neo4jBatchMigrationResult> {
    const startedAt = Date.now()
    const startTableIndex = Math.max(
      0,
      Math.min(resume?.tableIndex ?? 0, request.tables.length)
    )
    const currentResumeRows =
      startTableIndex < request.tables.length && resume?.tableIndex === startTableIndex
        ? resume?.rows ?? 0
        : 0
    let totalRows = startTableIndex < request.tables.length ? currentResumeRows : 0
    let bytes = 0
    const tableResults: Neo4jMigrationResult[] = []

    for (let index = startTableIndex; index < request.tables.length; index += 1) {
      const name = request.tables[index]
      if (name === undefined) {
        continue
      }
      const tableResumeRows = index === startTableIndex ? currentResumeRows : 0
      const outputFile = join(request.outputDirectory, safeFileName(request.kind, name))
      const tableResult = await this.exportTable(
        connection,
        {
          connectionId: request.connectionId,
          kind: request.kind,
          name,
          outputFile,
          batchSize: request.batchSize,
          ...(request.where ? { where: request.where } : {})
        },
        (processed) => {
          onProgress?.(totalRows - tableResumeRows + processed, {
            tableIndex: index,
            rows: processed
          })
        },
        tableResumeRows
      )

      totalRows += tableResult.rows - tableResumeRows
      bytes += tableResult.bytes ?? 0
      tableResults.push(tableResult)
      onProgress?.(totalRows, { tableIndex: index + 1, rows: 0 })
    }

    return {
      rows: totalRows,
      bytes,
      durationMs: Date.now() - startedAt,
      tables: tableResults
    }
  }

  // ============================================================
  // Internal: 单次 Cypher 拉取 → 归一化行流
  // ============================================================

  /**
   * 按批次分页拉取并归一化（`SKIP $offset LIMIT $batch` 循环直到取不满一批）。
   *
   * `batchSize` 是**单批页大小**而非总量上限：必须循环翻页，否则大批量导出会被静默截断。
   * 与 PG Connector 的 `OFFSET` 分页、ES Connector 的 scroll/search_after 同一语义。
   */
  private async streamRows(
    connection: ConnectionConfig,
    request: Neo4jExportRequest,
    offset: number,
    batchSize: number,
    onRow: (row: Record<string, unknown>) => Promise<void>
  ): Promise<void> {
    const pageSize =
      Number.isFinite(batchSize) && batchSize > 0 ? Math.max(1, Math.floor(batchSize)) : 1000
    const driver = this.factory(connection)
    try {
      const session = driver.session(sessionConfig(connection))
      try {
        let cursor = offset
        for (;;) {
          const result = await session.run(buildStreamCypher(request), {
            offset: neo4j.int(cursor),
            batch: neo4j.int(pageSize)
          })
          let fetched = 0
          for await (const record of result.records) {
            await onRow(buildRow(request.kind, record))
            fetched += 1
            cursor += 1
          }
          if (fetched < pageSize) {
            break
          }
        }
      } finally {
        await session.close()
      }
    } finally {
      await driver.close()
    }
  }
}

// ============================================================
// Cypher / 信封
// ============================================================

function buildStreamCypher(request: Neo4jExportRequest): string {
  const where =
    request.where && request.where.trim().length > 0 ? `WHERE ${request.where.trim()} ` : ''
  // `ORDER BY _id` 是续传正确性的前提（与 PG Connector 的 `ORDER BY <pk>` 同一协议）：
  // 图库的 MATCH 输出顺序不保证稳定，若 `SKIP $offset` 前的遍历顺序改变，
  // 断点续传会漏行或重复行。按稳定的标识（节点/关系内部 id）排序后再 SKIP/LIMIT。
  if (request.kind === 'node') {
    return (
      `MATCH (n:\`${escapeBackticks(request.name)}\`) ` +
      `${where}RETURN id(n) AS _id, labels(n) AS _labels, properties(n) AS properties ` +
      'ORDER BY _id SKIP $offset LIMIT $batch'
    )
  }
  return (
    `MATCH (a)-[r:\`${escapeBackticks(request.name)}\`]->(b) ` +
    `${where}RETURN id(r) AS _id, type(r) AS _type, id(startNode(r)) AS _src, ` +
    'id(endNode(r)) AS _dst, properties(r) AS properties ' +
    'ORDER BY _id SKIP $offset LIMIT $batch'
  )
}

function buildRow(
  kind: Neo4jTableKind,
  record: Record<string, unknown>
): Record<string, unknown> {
  if (kind === 'node') {
    return {
      _id: normalizeNeo4jValue(readField(record, '_id')),
      _labels: normalizeNeo4jValue(readField(record, '_labels')),
      properties: normalizeNeo4jValue(readField(record, 'properties'))
    }
  }
  return {
    _id: normalizeNeo4jValue(readField(record, '_id')),
    _type: toText(readField(record, '_type')),
    _src: normalizeNeo4jValue(readField(record, '_src')),
    _dst: normalizeNeo4jValue(readField(record, '_dst')),
    properties: normalizeNeo4jValue(readField(record, 'properties'))
  }
}

function safeFileName(kind: Neo4jTableKind, name: string): string {
  const prefix = kind === 'node' ? 'node' : 'relationship'
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'unnamed'
  return `${prefix}_${safe}.jsonl`
}

// ============================================================
// Normalize：Neo4j 驱动值 → JSON 兼容值
// ============================================================

/**
 * 把 Neo4j 驱动返回的复杂值归一化为 JSONL 可写的纯值（引擎 Normalize 层）。
 *
 * - `null` / `undefined` → `null`
 * - 标量 → 原样（`bigint` → number，保证可 JSON 序列化）
 * - 数组 → 递归
 * - Node → `{_id, _labels, properties}`
 * - Relationship → `{_id, _type, _src, _dst, properties}`
 * - Temporal → `toString()` 字符串；Spatial（Point）→ `{x, y, z, srid}`
 * - Integer → JS number
 * - 其它对象 → 递归归一化（默认 JSON 兜底）
 */
export function normalizeNeo4jValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'bigint') {
    return Number(value)
  }
  if (typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeNeo4jValue(item))
  }

  const record = value as Record<string, unknown>
  const typeName = constructorNameOf(value)

  if (TEMPORAL_TYPE_NAMES.has(typeName)) {
    const text = textualValueOf(value)
    if (text !== null) {
      return text
    }
  }

  if (typeName === 'Point' || ('x' in record && 'y' in record && 'srid' in record)) {
    return {
      x: normalizeNeo4jValue(record['x']),
      y: normalizeNeo4jValue(record['y']),
      z: normalizeNeo4jValue(record['z']),
      srid: normalizeNeo4jValue(record['srid'])
    }
  }

  if (
    typeName === 'Node' ||
    ('identity' in record && 'labels' in record && 'properties' in record)
  ) {
    return {
      _id: normalizeNeo4jValue(record['identity']),
      _labels: normalizeLabels(record['labels']),
      properties: normalizeNeo4jValue(record['properties'])
    }
  }

  if (
    typeName === 'Relationship' ||
    ('identity' in record &&
      'type' in record &&
      'start' in record &&
      'end' in record &&
      'properties' in record)
  ) {
    return {
      _id: normalizeNeo4jValue(record['identity']),
      _type: toText(record['type']),
      _src: normalizeNeo4jValue(record['start']),
      _dst: normalizeNeo4jValue(record['end']),
      properties: normalizeNeo4jValue(record['properties'])
    }
  }

  if (isIntegerLike(record, typeName)) {
    return integerToNumber(record)
  }

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    if (key === 'constructor') {
      continue
    }
    out[key] = normalizeNeo4jValue(item)
  }
  return out
}

function normalizeLabels(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return normalizeNeo4jValue(value)
  }
  return value.map((label) => toText(label))
}

function constructorNameOf(value: object): string {
  const ctor = (value as { constructor?: unknown }).constructor
  if (typeof ctor === 'function') {
    return ctor.name
  }
  if (ctor !== null && typeof ctor === 'object') {
    return toText((ctor as { name?: unknown }).name)
  }
  return ''
}

function textualValueOf(value: object): string | null {
  const toString = (value as { toString?: unknown }).toString
  if (typeof toString !== 'function') {
    return null
  }
  const text = String((toString as () => unknown).call(value))
  return text.length > 0 ? text : null
}

function isIntegerLike(record: Record<string, unknown>, typeName: string): boolean {
  if (typeof (record as { toNumber?: unknown }).toNumber === 'function') {
    return true
  }
  if (typeName === 'Integer') {
    return true
  }
  const keys = Object.keys(record)
  return (
    keys.length > 0 &&
    keys.length <= 2 &&
    keys.every((key) => key === 'low' || key === 'high') &&
    typeof record['low'] === 'number' &&
    typeof record['high'] === 'number'
  )
}

function integerToNumber(record: Record<string, unknown>): number {
  const toNumberFn = (record as { toNumber?: unknown }).toNumber
  if (typeof toNumberFn === 'function') {
    return (toNumberFn as () => number).call(record)
  }
  const low = Number(record['low'] ?? 0)
  const high = Number(record['high'] ?? 0)
  return high * 4294967296 + low
}

// ============================================================
// 驱动访问小工具
// ============================================================

function sessionConfig(connection: ConnectionConfig): { database?: string } | undefined {
  return connection.database && connection.database.length > 0
    ? { database: connection.database }
    : undefined
}

function readField(record: Record<string, unknown> | null, key: string): unknown {
  if (!record) {
    return undefined
  }
  const getter = (record as { get?: unknown }).get
  if (typeof getter === 'function') {
    try {
      return (getter as (k: string) => unknown).call(record, key)
    } catch {
      return undefined
    }
  }
  return record[key]
}

async function firstRecord(result: Neo4jResultLike): Promise<Record<string, unknown> | null> {
  for await (const record of result.records) {
    return record
  }
  return null
}

async function collectStrings(
  driver: Neo4jServiceDriverLike,
  connection: ConnectionConfig,
  cypher: string,
  extract: (record: Record<string, unknown>) => string
): Promise<string[]> {
  const session = driver.session(sessionConfig(connection))
  try {
    const result = await session.run(cypher)
    const values: string[] = []
    for await (const record of result.records) {
      const value = extract(record)
      if (value.length > 0) {
        values.push(value)
      }
    }
    return values
  } finally {
    await session.close()
  }
}

function toText(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  return typeof value === 'string' ? value : String(value)
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0
  }
  if (typeof value === 'bigint') {
    return Number(value)
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  if (value !== null && typeof value === 'object') {
    const converted = integerToNumber(value as Record<string, unknown>)
    return Number.isFinite(converted) ? converted : 0
  }
  return 0
}

function productFamilyName(name: string): string {
  const family = name.trim().split(/\s+/)[0] ?? ''
  return family.length > 0 ? family : 'Neo4j'
}

function escapeBackticks(value: string): string {
  return value.replace(/`/g, '``')
}

function resolveNeo4jUri(connection: ConnectionConfig): string {
  if (connection.uri && /^bolt(\+s)?:\/\//.test(connection.uri)) {
    return connection.uri
  }
  const scheme = connection.ssl ? 'bolt+s' : 'bolt'
  return `${scheme}://${connection.host}:${connection.port}`
}

// ============================================================
// `.part` 续传协议
// ============================================================

interface Neo4jPartState {
  /** 已完整落盘的导出行数（各信封 rows 之和） */
  rows: number
  /** 文件字节数 */
  size: number
  /** 末尾不可解析的残行字节数（0 = 文件完整） */
  incompleteBytes: number
}

/**
 * 读取 `.part` 的续传状态。
 *
 * 每行是一条完整节点/关系记录，因此续传行数按有效 JSON 行计数；
 * 末尾残行（中断写入）不计入行数，由调用方截断。
 * 本 Connector 只以 `\n` 写入，故按「行长 + 1 字节」累计偏移。
 */
async function readPartState(partFile: string): Promise<Neo4jPartState> {
  let size = 0
  try {
    const info = await stat(partFile)
    if (!info.isFile()) {
      return { rows: 0, size: 0, incompleteBytes: 0 }
    }
    size = info.size
  } catch {
    return { rows: 0, size: 0, incompleteBytes: 0 }
  }

  let rows = 0
  let completeBytes = 0
  let consumed = 0
  const input = createReadStream(partFile, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      consumed += Buffer.byteLength(line, 'utf8') + 1
      if (line.trim().length === 0) {
        completeBytes = consumed
        continue
      }
      if (!isValidRecordLine(line)) {
        break
      }
      rows += 1
      completeBytes = consumed
    }
  } finally {
    lines.close()
    input.destroy()
  }
  return { rows, size, incompleteBytes: size - completeBytes }
}

/** 等待写入流 settle（fd 已 open 并 close），用于错误路径上确定 `.part` 的最终状态。 */
async function settleWriteStream(stream: WriteStream): Promise<void> {
  if (stream.closed) {
    return
  }
  await finished(stream).catch(() => undefined)
}

function isValidRecordLine(line: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return false
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
}

// ============================================================
// 错误处理
// ============================================================

function mapExportError(error: unknown, request: Neo4jExportRequest, written: number): Error {
  if (error instanceof TaskCancelledError) {
    return error
  }
  if (isCancellationError(error)) {
    // 驱动侧取消 → 归一化为引擎统一的取消信号，`.part` 保留以便续传
    return new TaskCancelledError(request.connectionId)
  }
  const message = error instanceof Error ? error.message : String(error)
  return new Error(
    `Neo4j 导出失败 (${request.kind}='${request.name}'，已写 ${written} 行)：${message}`
  )
}

function isCancellationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown }).code
  return /cancel|terminat|interrupt|shutdown/i.test(`${typeof code === 'string' ? code : ''} ${message}`)
}

function classifyNeo4jError(error: unknown): string {
  const code = (error as { code?: unknown }).code
  const codeText = typeof code === 'string' ? code : ''
  const message = error instanceof Error ? error.message : String(error)
  if (
    codeText.includes('ServiceUnavailable') ||
    message.includes('ServiceUnavailable') ||
    message.includes('ECONNREFUSED')
  ) {
    return 'Neo4j 连接被拒绝。请检查主机是否可达、端口是否正确、防火墙是否放行。'
  }
  if (codeText.includes('Unauthorized') || message.includes('Unauthorized')) {
    return 'Neo4j 认证失败。请检查用户名和密码。'
  }
  if (message.includes('SSL') || message.includes('TLS')) {
    return 'Neo4j TLS/SSL 握手失败。如使用自签证书，请在连接配置中关闭 SSL 或配置信任。'
  }
  if (message.includes('database')) {
    return `Neo4j 数据库错误：${message}`
  }
  return `Neo4j 错误：${message}`
}

// ============================================================
// 生产驱动接入（仅当未注入 factory 时使用）
// ============================================================

const defaultDriverFactory: Neo4jServiceDriverFactory = (connection) => {
  const driver: Driver = neo4j.driver(
    resolveNeo4jUri(connection),
    neo4j.auth.basic(connection.username ?? '', connection.password ?? '')
  )
  return wrapDriver(driver)
}

function wrapDriver(driver: Driver): Neo4jServiceDriverLike {
  return {
    session: (config) => wrapSession(driver.session(config)),
    close: () => driver.close()
  }
}

function wrapSession(session: Session): Neo4jSessionLike {
  return {
    run: async (cypher, params) => {
      const result = await session.run(cypher, params)
      return { records: toRecordIterable(result) }
    },
    close: () => session.close()
  }
}

/** 真实驱动 Result 既支持 `records: Record[]` 也支持异步迭代；统一为异步可迭代。 */
function toRecordIterable(result: unknown): AsyncIterable<Record<string, unknown>> {
  const source = result as {
    records?: unknown
    [Symbol.asyncIterator]?: unknown
  }
  if (typeof source[Symbol.asyncIterator] === 'function') {
    return result as AsyncIterable<Record<string, unknown>>
  }
  const records = source.records
  if (Array.isArray(records)) {
    return (async function* iterate(): AsyncGenerator<Record<string, unknown>> {
      for (const record of records as Record<string, unknown>[]) {
        yield record
      }
    })()
  }
  return (async function* empty(): AsyncGenerator<Record<string, unknown>> {
    // 无记录
  })()
}

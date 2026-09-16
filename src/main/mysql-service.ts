import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { finished } from 'node:stream/promises'

import type {
  ConnectionConfig,
  MySQLBatchExportRequest,
  MySQLBatchMigrationResult,
  MySQLColumn,
  MySQLConflictAction,
  MySQLConnectionTestResult,
  MySQLCountRowsRequest,
  MySQLExportRequest,
  MySQLImportRequest,
  MySQLMigrationResult,
  MySQLTable,
  MySQLTableRef
} from '../shared/types'
import {
  assertSelectedColumnsPresent,
  projectRecord
} from '../shared/column-projection'
import { transformRecord } from '../shared/type-conversion'
import { expandJsonlRecord } from '../shared/jsonl-record'
import { TaskCancelledError } from './task-errors'

/**
 * MySQL 走 Node.js Source Connector（mysql2/promise），与 PostgresService 接口严格对齐：
 * listDatabases / listTables / countRows / testConnection / exportTable / exportTables。
 *
 * 引擎层契约（Source → Normalize）：
 * - Source：`SELECT * FROM \`db\`.\`table\`` 流式游标（mysql2 `.stream()`，服务端游标不占内存）
 * - Normalize：分批写 JSONL，每行一个批次信封 `{table:{schema,name}, columns, rows:any[][]}`，
 *   与 Go pgmigrator / esmigrator 使用的引擎信封同构（schema 字段承载 database 名）。
 * - 续传：`.part` 文件 + `LIMIT/OFFSET`（有主键时 ORDER BY 主键，保证 OFFSET 稳定）
 * - 取消：TaskCancelledError（由 onProgress 回调抛出，与 PG 完全一致）
 */

export interface MySQLQueryResultRow {
  [column: string]: unknown
}

/** mysql2 的流式游标（Readable）。 */
export interface MySQLRowStream {
  on(event: 'data' | 'end' | 'error', listener: (...args: any[]) => void): unknown
  destroy?: () => unknown
  pause?: () => unknown
  resume?: () => unknown
  [Symbol.asyncIterator]?: () => AsyncIterator<MySQLQueryResultRow>
}

export interface MySQLClientLike {
  connect: () => Promise<unknown>
  end: () => Promise<void>
  /**
   * 元数据查询（返回行对象数组）。
   *
   * 返回类型标注为 `Promise<T[]> | any`：泛型仅供调用方标注列形状，同时允许测试注入
   * 返回具体行类型的 mock（与 PostgresClientLike 的 `| any` 写法保持同构）。
   */
  query: <T = MySQLQueryResultRow>(sql: string, params?: unknown[]) => Promise<T[]> | any
  /** 数据导出游标（流式行对象）。 */
  stream: (sql: string, params?: unknown[]) => MySQLRowStream
}

export interface MySQLConnectionOptions {
  host: string
  port: number
  user?: string
  password?: string
  database?: string
  connectTimeout: number
  supportBigNumbers: boolean
  bigNumberStrings: boolean
  multipleStatements: boolean
  ssl?: Record<string, unknown>
}

export type MySQLClientFactory = (options: MySQLConnectionOptions) => MySQLClientLike

export interface MySQLBatchExportCursor {
  tableIndex: number
  rows: number
}

type MySQLPromiseConnection = {
  query: (sql: string, params?: unknown[]) => Promise<unknown[]>
  end: () => Promise<void>
  destroy: () => void
  connection: {
    query: (sql: string) => { stream: () => MySQLRowStream }
  }
}

/**
 * `LIMIT <max>` = "no limit"（MySQL 规定 LIMIT 必须搭配 OFFSET 才能跳过行）。
 * 必须以字符串形式下发：2^64-1 超出 JS Number.MAX_SAFE_INTEGER，数字字面量会被
 * 舍入成 18446744073709552000 从而被 MySQL 判为越界语法错误。
 */
const READ_BATCH_KEY = '18446744073709551615'
const MAX_QUERY_PARAMS = 60_000

export class MySQLService {
  private readonly factory: MySQLClientFactory

  constructor(factory: MySQLClientFactory = defaultMySQLClientFactory) {
    this.factory = factory
  }

  async testConnection(
    connection: ConnectionConfig,
    database?: string
  ): Promise<MySQLConnectionTestResult> {
    try {
      const serverVersion = await this.withClient(connection, database, async (client) => {
        const rows = await client.query<{ version: unknown }>('SELECT VERSION() AS version')
        return String(rows[0]?.version ?? '')
      })
      return { ok: true, serverVersion }
    } catch (error) {
      return { ok: false, message: mysqlErrorMessage(error, connection) }
    }
  }

  async listDatabases(connection: ConnectionConfig): Promise<string[]> {
    return this.withClient(connection, undefined, async (client) => {
      const rows = (await client.query(`
        SELECT SCHEMA_NAME AS name
        FROM information_schema.SCHEMATA
        ORDER BY SCHEMA_NAME
      `)) as Array<{ name: unknown }>
      return rows.map((row) => String(row.name))
    })
  }

  async listTables(
    connection: ConnectionConfig,
    database?: string
  ): Promise<MySQLTable[]> {
    const target = resolveDatabase(connection, database)

    return this.withClient(connection, target, async (client) => {
      const tables = (await client.query(
        `
          SELECT TABLE_NAME AS name, TABLE_ROWS AS estimated_rows
          FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_NAME
        `,
        [target]
      )) as Array<{ name: unknown; estimated_rows: unknown }>

      const columns = (await client.query(
        `
          SELECT
            TABLE_NAME AS name,
            COLUMN_NAME AS column_name,
            COLUMN_TYPE AS data_type,
            IS_NULLABLE AS is_nullable,
            COLUMN_KEY AS column_key,
            EXTRA AS extra
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ?
          ORDER BY TABLE_NAME, ORDINAL_POSITION
        `,
        [target]
      )) as Array<{
        name: unknown
        column_name: unknown
        data_type: unknown
        is_nullable: unknown
        column_key: unknown
        extra: unknown
      }>

      const columnsByTable = new Map<string, MySQLColumn[]>()
      for (const column of columns) {
        const key = String(column.name)
        const list = columnsByTable.get(key) ?? []
        list.push({
          name: String(column.column_name),
          dataType: String(column.data_type ?? ''),
          isNullable: String(column.is_nullable).toUpperCase() === 'YES',
          isPrimaryKey: String(column.column_key).toUpperCase() === 'PRI',
          isGenerated: /GENERATED/i.test(String(column.extra ?? ''))
        })
        columnsByTable.set(key, list)
      }

      return tables.map((table) => {
        const name = String(table.name)
        const estimatedRows = Number(table.estimated_rows)
        return {
          // MySQL 没有 schema 概念：schema 字段承载 database 名。
          schema: target,
          name,
          estimatedRows:
            table.estimated_rows !== null && Number.isFinite(estimatedRows) && estimatedRows >= 0
              ? estimatedRows
              : null,
          columns: columnsByTable.get(name) ?? []
        }
      })
    })
  }

  async countRows(
    connection: ConnectionConfig,
    request: MySQLCountRowsRequest
  ): Promise<number> {
    const database = resolveDatabase(connection, request.database, request.table.schema)
    return this.withClient(connection, database, async (client) => {
      const rows = await client.query<{ count: unknown }>(
        `SELECT COUNT(1) AS count FROM ${qualifiedTable(database, request.table.name)}`
      )
      const count = Number(rows[0]?.count ?? 0)
      return Number.isFinite(count) ? count : 0
    })
  }

  async exportTable(
    connection: ConnectionConfig,
    request: MySQLExportRequest,
    onProgress?: (processedRows: number, cursor?: unknown) => void,
    resumeRows = 0
  ): Promise<MySQLMigrationResult> {
    const startedAt = performance.now()
    const database = resolveDatabase(connection, request.database, request.table.schema)
    const temporaryPath = `${request.outputFile}.part`
    let rows = resumeRows

    try {
      await mkdir(dirname(request.outputFile), { recursive: true })
      await this.withClient(connection, database, async (client) => {
        const columns = await listTableColumns(client, database, request.table.name)
        if (columns.length === 0) {
          throw new Error(`表不存在或没有列：${qualifiedTable(database, request.table.name)}`)
        }
        const columnNames = columns.map((column) => column.name)
        const envelopeTable = { schema: database, name: request.table.name }
        // 续传时追加到既有 .part 文件（与 PG 的 .part 协议一致）。
        const output = createWriteStream(temporaryPath, {
          encoding: 'utf8',
          flags: resumeRows > 0 ? 'a' : 'w'
        })
        const stream = client.stream(
          buildSelectSql(database, request.table.name, columns, resumeRows)
        )
        rows = resumeRows

        try {
          let pending: unknown[][] = []
          let notify = false
          for await (const row of stream as AsyncIterable<Record<string, unknown>>) {
            pending.push(columnNames.map((name) => row[name]))
            if (pending.length >= request.batchSize) {
              // 一行 = 一个批次信封，与 Go 引擎 JSONL 契约同构。
              const line = `${stringifyEnvelope(envelopeTable, columnNames, pending)}\n`
              if (!output.write(line)) {
                await once(output, 'drain')
              }
              rows += pending.length
              pending = []
              notify = true
            }
            if (notify) {
              notify = false
              // 取消信号由 TaskManager 通过 onProgress 抛出（与 PG 一致）。
              onProgress?.(rows, rows)
            }
          }

          // 收尾批次即使不足 batchSize 也要落盘。
          if (pending.length > 0) {
            const line = `${stringifyEnvelope(envelopeTable, columnNames, pending)}\n`
            if (!output.write(line)) {
              await once(output, 'drain')
            }
            rows += pending.length
          }

          output.end()
          await finished(output)
          onProgress?.(rows, rows)
        } catch (error) {
          stream.destroy?.()
          if (error instanceof TaskCancelledError) {
            // 取消：已写入的批次必须 flush 到 `.part`（与 PG 的 .part 续传协议一致），
            // 因此用 end() + finished() 而不是 destroy()——destroy() 会丢弃未落盘的缓冲区。
            output.end()
            await finished(output).catch(() => undefined)
          } else {
            output.destroy()
          }
          throw error
        }
      })

      const bytes = (await stat(temporaryPath)).size
      await rm(request.outputFile, { force: true })
      await rename(temporaryPath, request.outputFile)
      return {
        rows,
        bytes,
        durationMs: performance.now() - startedAt,
        table: { schema: database, name: request.table.name }
      }
    } catch (error) {
      if (!(error instanceof TaskCancelledError)) {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
      }
      throw error
    }
  }

  async exportTables(
    connection: ConnectionConfig,
    request: MySQLBatchExportRequest,
    onProgress?: (processedRows: number, cursor?: unknown) => void,
    resume?: MySQLBatchExportCursor
  ): Promise<MySQLBatchMigrationResult> {
    const startedAt = performance.now()
    const database = resolveDatabase(connection, request.database)
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
    const tableResults: MySQLMigrationResult[] = []

    for (let index = startTableIndex; index < request.tables.length; index += 1) {
      const table = request.tables[index]
      if (!table) {
        continue
      }
      const tableResumeRows = index === startTableIndex ? currentResumeRows : 0
      const tableDatabase = table.schema || database
      const outputFile = join(
        request.outputDirectory,
        tableExportFileName(tableDatabase, table.name)
      )
      const tableResult = await this.exportTable(
        connection,
        {
          connectionId: request.connectionId,
          table,
          outputFile,
          batchSize: request.batchSize,
          database: tableDatabase
        },
        (processed) => {
          const progress = totalRows - tableResumeRows + processed
          onProgress?.(progress, {
            tableIndex: index,
            rows: tableResumeRows + processed
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
      durationMs: performance.now() - startedAt,
      tables: tableResults
    }
  }

  async importJsonl(
    connection: ConnectionConfig,
    request: MySQLImportRequest,
    onProgress?: (processedRows: number, cursor?: unknown) => void,
    resume?: { lines: number; rows: number }
  ): Promise<MySQLMigrationResult> {
    const startedAt = performance.now()
    const database = resolveDatabase(connection, request.database, request.table.schema)
    let rows = resume?.rows ?? 0

    await this.withClient(connection, database, async (client) => {
      const columns = await listTableColumns(client, database, request.table.name)
      const insertableColumns = columns.filter((column) => !column.isGenerated)
      if (insertableColumns.length === 0) {
        throw new Error('目标表没有可写入的列')
      }
      const targetTypes = new Map(
        insertableColumns.map((column) => [column.name, column.dataType])
      )

      const input = createReadStream(request.inputFile, { encoding: 'utf8' })
      const lines = createInterface({ input, crlfDelay: Infinity })
      let pending: Array<Record<string, unknown>> = []
      let lineNumber = 0

      for await (const line of lines) {
        lineNumber += 1
        if (resume && lineNumber <= resume.lines) {
          continue
        }
        if (line.trim().length === 0) {
          continue
        }

        let record: unknown
        try {
          record = JSON.parse(line)
        } catch {
          throw new Error(`第 ${lineNumber} 行不是有效 JSON`)
        }
        // 批次信封 {table, columns, rows} 展开为逐行 Record；
        // PG/ES 导出的逐行记录原样透传（与 PostgresService.importJsonl 同构）。
        const batch = expandJsonlRecord(record, lineNumber)
        for (const row of batch) {
          assertKnownColumns(row, columns, lineNumber)
          assertSelectedColumnsPresent(
            Object.keys(row),
            request.selectedColumns,
            lineNumber
          )
          const transformed = transformRecord(
            projectRecord(row, request.selectedColumns),
            request.fieldTransforms,
            targetTypes,
            lineNumber
          )
          assertKnownColumns(transformed, columns, lineNumber)
          pending.push(transformed)
        }
        // 行边界 flush：续传游标（lines）与已落库数据严格对齐。
        if (pending.length >= request.batchSize) {
          await insertBatch(
            client,
            { schema: database, name: request.table.name },
            pending,
            insertableColumns,
            request.onConflict
          )
          rows += pending.length
          pending = []
          onProgress?.(rows, lineNumber)
        }
      }

      if (pending.length > 0) {
        await insertBatch(
          client,
          { schema: database, name: request.table.name },
          pending,
          insertableColumns,
          request.onConflict
        )
        rows += pending.length
        onProgress?.(rows, lineNumber)
      }
    })

    return {
      rows,
      durationMs: performance.now() - startedAt,
      table: { schema: database, name: request.table.name }
    }
  }

  private async withClient<T>(
    connection: ConnectionConfig,
    database: string | undefined,
    operation: (client: MySQLClientLike) => Promise<T>
  ): Promise<T> {
    const options = await buildConnectionOptions(connection, database)
    const client = this.factory(options)
    await client.connect()
    try {
      return await operation(client)
    } finally {
      await client.end().catch(() => undefined)
    }
  }
}

/** 默认工厂：延迟加载 mysql2/promise，避免应用启动时即建立驱动依赖。 */
function defaultMySQLClientFactory(options: MySQLConnectionOptions): MySQLClientLike {
  let connection: MySQLPromiseConnection | null = null

  return {
    async connect(): Promise<void> {
      const mysql = await import('mysql2/promise')
      connection = (await mysql.createConnection(
        options as unknown as Parameters<typeof mysql.createConnection>[0]
      )) as unknown as MySQLPromiseConnection
    },
    async end(): Promise<void> {
      if (connection) {
        connection.destroy()
        connection = null
      }
    },
    async query<T = MySQLQueryResultRow>(sql: string, params?: unknown[]): Promise<T[]> {
      if (!connection) {
        throw new Error('MySQL 连接尚未建立')
      }
      const [rows] = (await connection.query(sql, params)) as [T[], unknown]
      return rows
    },
    stream(sql: string): MySQLRowStream {
      if (!connection) {
        throw new Error('MySQL 连接尚未建立')
      }
      // mysql2 的 promise 连接保留核心连接；核心 query + .stream() 走服务端流式游标。
      return connection.connection.query(sql).stream()
    }
  }
}

async function buildConnectionOptions(
  connection: ConnectionConfig,
  database?: string
): Promise<MySQLConnectionOptions> {
  const options: MySQLConnectionOptions = {
    host: connection.host,
    port: connection.port,
    user: connection.username || undefined,
    password: connection.password || undefined,
    database: database || connection.database || undefined,
    connectTimeout: 10_000,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false
  }

  if (connection.ssl) {
    const ssl: Record<string, unknown> = { rejectUnauthorized: false }
    if (connection.sslCa) {
      ssl.ca = await readFile(connection.sslCa, 'utf8').catch(() => undefined)
      if (ssl.ca === undefined) {
        throw new Error(`无法读取 CA 证书：${connection.sslCa}`)
      }
    }
    if (connection.sslCert) {
      ssl.cert = await readFile(connection.sslCert, 'utf8')
    }
    options.ssl = ssl
  }

  return options
}

function resolveDatabase(
  connection: ConnectionConfig,
  database?: string,
  fallback?: string
): string {
  const value = (database ?? fallback ?? connection.database ?? '').trim()
  if (value.length === 0) {
    throw new Error('请先选择 MySQL 数据库')
  }
  return value
}

function qualifiedTable(database: string, table: string): string {
  return `${escapeIdentifier(database)}.${escapeIdentifier(table)}`
}

function escapeIdentifier(value: string): string {
  return `\`${value.replace(/`/g, '``')}\``
}

function buildSelectSql(
  database: string,
  table: string,
  columns: MySQLColumn[],
  offset: number
): string {
  const primaryKeys = columns.filter((column) => column.isPrimaryKey).map((column) => column.name)
  const orderBy =
    primaryKeys.length > 0
      ? ` ORDER BY ${primaryKeys.map(escapeIdentifier).join(', ')}`
      : ''
  const offsetClause = offset > 0 ? ` LIMIT ${READ_BATCH_KEY} OFFSET ${offset}` : ''
  return `SELECT * FROM ${qualifiedTable(database, table)}${orderBy}${offsetClause}`
}

function stringifyEnvelope(
  table: { schema: string; name: string },
  columns: string[],
  rows: unknown[][]
): string {
  return JSON.stringify({ table, columns, rows }, jsonReplacer)
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

function tableExportFileName(database: string, table: string): string {
  const safePart = (value: string): string =>
    value.replace(/[\\/:*?"<>|]/g, '_').trim() || 'table'
  return `${safePart(database)}.${safePart(table)}.jsonl`
}

async function listTableColumns(
  client: MySQLClientLike,
  database: string,
  table: string
): Promise<MySQLColumn[]> {
  const rows = (await client.query(
    `
      SELECT
        COLUMN_NAME AS column_name,
        COLUMN_TYPE AS data_type,
        IS_NULLABLE AS is_nullable,
        COLUMN_KEY AS column_key,
        EXTRA AS extra
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `,
    [database, table]
  )) as Array<{
    column_name: unknown
    data_type: unknown
    is_nullable: unknown
    column_key: unknown
    extra: unknown
  }>

  return rows.map((row) => ({
    name: String(row.column_name),
    dataType: String(row.data_type ?? ''),
    isNullable: String(row.is_nullable).toUpperCase() === 'YES',
    isPrimaryKey: String(row.column_key).toUpperCase() === 'PRI',
    isGenerated: /GENERATED/i.test(String(row.extra ?? ''))
  }))
}

function assertKnownColumns(
  row: Record<string, unknown>,
  columns: MySQLColumn[],
  lineNumber: number
): void {
  const known = new Set(columns.map((column) => column.name))
  const unknown = Object.keys(row).filter((key) => !known.has(key))
  if (unknown.length > 0) {
    throw new Error(
      `目标表 ${columns[0] ? '缺失列' : ''}：${unknown.join(', ')}（第 ${lineNumber} 行）`
    )
  }
}

async function insertBatch(
  client: MySQLClientLike,
  table: MySQLTableRef,
  rows: Array<Record<string, unknown>>,
  columns: MySQLColumn[],
  onConflict: MySQLConflictAction
): Promise<void> {
  const first = rows[0]
  if (!first) {
    return
  }
  const insertable = new Set(columns.map((column) => column.name))
  const keys = Object.keys(first).filter((key) => insertable.has(key))
  if (keys.length === 0) {
    throw new Error('JSON 行中没有可写入的列')
  }

  const effectiveBatchSize = Math.max(
    1,
    Math.min(rows.length, Math.floor(MAX_QUERY_PARAMS / keys.length))
  )

  for (let offset = 0; offset < rows.length; offset += effectiveBatchSize) {
    const batch = rows.slice(offset, offset + effectiveBatchSize)
    const valueGroups = batch.map(() => `(${keys.map(() => '?').join(', ')})`)
    const values = batch.flatMap((row) => keys.map((key) => toMysqlValue(row[key])))
    const conflictSuffix = conflictSuffixFor(onConflict, keys)
    const sql =
      `INSERT ` +
      (onConflict === 'skip' ? 'IGNORE ' : '') +
      `INTO ${qualifiedTableFor(table.schema, table.name)} ` +
      `(${keys.map((k) => `\`${k.replace(/`/g, '``')}\``).join(', ')}) ` +
      `VALUES ${valueGroups.join(', ')}${conflictSuffix}`
    await client.query(sql, values)
  }
}

function conflictSuffixFor(onConflict: MySQLConflictAction, keys: string[]): string {
  if (onConflict !== 'update' || keys.length === 0) {
    return ''
  }
  const assignments = keys
    .map((key) => `\`${key.replace(/`/g, '``')}\` = VALUES(\`${key.replace(/`/g, '``')}\`)`)
    .join(', ')
  return ` ON DUPLICATE KEY UPDATE ${assignments}`
}

function qualifiedTableFor(database: string, table: string): string {
  return `\`${database.replace(/`/g, '``')}\`.\`${table.replace(/`/g, '``')}\``
}

/**
 * MySQL Sink 端最小 cast：与 PG 的 toPgValue 同等级，零新 type-mapping 配置入口。
 *
 * - null/undefined → NULL
 * - boolean → 0/1（MySQL 没有原生 BOOLEAN，TINYINT(1) 是约定语义）
 * - Date → 'YYYY-MM-DD HH:MM:SS.mmm' 本地时区字符串（与 mysql2 默认 DATETIME 格式对齐）
 * - Buffer → hex 字符串（mysql2 BLOB 默认接受 hex）
 * - object/Array → JSON 字符串（goals.md Goal 6 默认 JSON 兜底）
 * - 其他 → 透传
 */
export function toMysqlValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null
    }
    const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
    return (
      `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
      `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}.` +
      `${pad(value.getMilliseconds(), 3)}`
    )
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('hex')
  }
  if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
    const obj = value as { type?: unknown; data?: unknown }
    // MySQL 导出器落的 Buffer 序列化为 {type:'Buffer', data:[...]}
    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
      return Buffer.from(obj.data as number[]).toString('hex')
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value)
  }
  return value
}

/** 保留 mysql2 的 errno/code，使 Access denied / Unknown database / ECONNREFUSED 可读。 */
export function mysqlErrorMessage(error: unknown, connection?: ConnectionConfig): string {
  const record = (error ?? {}) as { code?: unknown; sqlMessage?: unknown; message?: unknown }
  const code = typeof record.code === 'string' ? record.code : undefined
  const base =
    (typeof record.sqlMessage === 'string' && record.sqlMessage) ||
    (typeof record.message === 'string' && record.message) ||
    'MySQL 操作失败'
  const suffix = code && !base.includes(code) ? ` [${code}]` : ''
  if (!code) {
    return base
  }

  let hint = ''
  if (code === 'ECONNREFUSED') {
    hint = connection
      ? `（连接被拒绝：${connection.host}:${connection.port}）`
      : '（连接被拒绝）'
  } else if (code === 'ETIMEDOUT' || code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
    hint = '（连接超时）'
  } else if (code === 'ENOTFOUND') {
    hint = '（主机名无法解析）'
  } else if (code === 'ER_BAD_DB_ERROR') {
    hint = '（数据库不存在）'
  }
  return `${base}${suffix}${hint}`
}

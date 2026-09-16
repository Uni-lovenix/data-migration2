import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { finished } from 'node:stream/promises'

import { Client, escapeIdentifier, type ClientConfig } from 'pg'
import QueryStream from 'pg-query-stream'

import type {
  ConnectionConfig,
  PostgresColumn,
  PostgresConflictAction,
  PostgresConnectionTestResult,
  PostgresBatchExportRequest,
  PostgresBatchMigrationResult,
  PostgresCountRowsRequest,
  PostgresExportRequest,
  PostgresImportRequest,
  PostgresMigrationResult,
  PostgresTable,
  PostgresTableRef
} from '../shared/types'
import {
  assertSelectedColumnsPresent,
  projectRecord
} from '../shared/column-projection'
import { expandJsonlRecord } from '../shared/jsonl-record'
import { TaskCancelledError } from './task-errors'

const MAX_QUERY_PARAMS = 60_000

export interface PostgresClientLike {
  connect: () => Promise<unknown>
  end: () => Promise<void>
  query: <R = any>(...args: any[]) => Promise<{ rows: R[] }> | any
}

export interface PostgresBatchExportCursor {
  tableIndex: number
  rows: number
}

export type PostgresClientFactory = (config: ClientConfig) => PostgresClientLike

export class PostgresService {
  private readonly factory: PostgresClientFactory

  constructor(factory: PostgresClientFactory = (config) => new Client(config)) {
    this.factory = factory
  }

  async testConnection(
    connection: ConnectionConfig,
    database?: string
  ): Promise<PostgresConnectionTestResult> {
    try {
      const serverVersion = await this.withClient(connection, database, async (client) => {
        const result = await client.query<{ version: string }>('SELECT version() AS version')
        const version = result.rows[0]?.version ?? ''
        return version.match(/PostgreSQL ([\d.]+)/)?.[1] ?? version
      })
      return { ok: true, serverVersion }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }

  async listDatabases(connection: ConnectionConfig): Promise<string[]> {
    return this.withClient(connection, undefined, async (client) => {
      const result = await client.query<{ name: string }>(`
        SELECT datname AS name
        FROM pg_database
        ORDER BY datistemplate, datname
      `)
      return result.rows.map((row: { name: string }) => row.name)
    })
  }

  async listTables(
    connection: ConnectionConfig,
    database?: string
  ): Promise<PostgresTable[]> {
    return this.withClient(connection, database, async (client) => {
      const tablesResult = await client.query<{
        schema: string
        name: string
        estimated_rows: number | null
      }>(`
        SELECT
          n.nspname AS schema,
          c.relname AS name,
          c.reltuples::bigint AS estimated_rows
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY n.nspname, c.relname
      `)

      const columnsResult = await client.query<{
        schema: string
        name: string
        column_name: string
        data_type: string
        is_nullable: boolean
        is_primary_key: boolean
        is_generated: string
      }>(`
        SELECT
          cols.table_schema AS schema,
          cols.table_name AS name,
          cols.column_name AS column_name,
          cols.data_type AS data_type,
          cols.is_nullable = 'YES' AS is_nullable,
          EXISTS (
            SELECT 1
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_name = tc.constraint_name
              AND kcu.table_schema = tc.table_schema
              AND kcu.table_name = tc.table_name
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema = cols.table_schema
              AND tc.table_name = cols.table_name
              AND kcu.column_name = cols.column_name
          ) AS is_primary_key,
          cols.is_generated AS is_generated
        FROM information_schema.columns cols
        WHERE cols.table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY cols.table_schema, cols.table_name, cols.ordinal_position
      `)

      const columnsByTable = new Map<string, PostgresColumn[]>()
      for (const column of columnsResult.rows) {
        const key = tableKey(column.schema, column.name)
        const columns = columnsByTable.get(key) ?? []
        columns.push({
          name: column.column_name,
          dataType: column.data_type,
          isNullable: column.is_nullable,
          isPrimaryKey: column.is_primary_key,
          isGenerated: column.is_generated === 'ALWAYS'
        })
        columnsByTable.set(key, columns)
      }

      return tablesResult.rows.map((table: {
        schema: string
        name: string
        estimated_rows: number | null
      }) => ({
        schema: table.schema,
        name: table.name,
        estimatedRows: table.estimated_rows !== null && table.estimated_rows >= 0
          ? table.estimated_rows
          : null,
        columns: columnsByTable.get(tableKey(table.schema, table.name)) ?? []
      }))
    })
  }

  async countRows(
    connection: ConnectionConfig,
    request: PostgresCountRowsRequest
  ): Promise<number> {
    return this.withClient(connection, request.database, async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(1)::text AS count FROM ${qualifiedTable(request.table)}`
      )
      const count = Number(result.rows[0]?.count ?? 0)
      return Number.isFinite(count) ? count : 0
    })
  }

  async exportTable(
    connection: ConnectionConfig,
    request: PostgresExportRequest,
    onProgress?: (processedRows: number, cursor?: unknown) => void,
    resumeRows = 0
  ): Promise<PostgresMigrationResult> {
    const startedAt = performance.now()
    const temporaryPath = `${request.outputFile}.part`
    let rows = resumeRows

    try {
      await mkdir(dirname(request.outputFile), { recursive: true })
      await this.withClient(connection, request.database, async (client) => {
        const query = resumeRows > 0
          ? await buildResumeExportQuery(client, request.table, resumeRows, request.where)
          : selectAllFromQualified(qualifiedTable(request.table), request.where)
        const stream = client.query(
          new QueryStream(query)
        )
        await writeRowsToJsonl(
          stream,
          temporaryPath,
          (processed) => {
            rows = processed
            onProgress?.(processed, processed)
          },
          resumeRows,
          resumeRows > 0 ? 'a' : 'w'
        )
      })

      const bytes = (await stat(temporaryPath)).size
      await rm(request.outputFile, { force: true })
      await rename(temporaryPath, request.outputFile)
      return {
        rows,
        bytes,
        durationMs: performance.now() - startedAt,
        table: request.table
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
    request: PostgresBatchExportRequest,
    onProgress?: (processedRows: number, cursor?: unknown) => void,
    resume?: PostgresBatchExportCursor
  ): Promise<PostgresBatchMigrationResult> {
    const startedAt = performance.now()
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
    const tableResults: PostgresMigrationResult[] = []

    for (let index = startTableIndex; index < request.tables.length; index += 1) {
      const table = request.tables[index]
      if (!table) {
        continue
      }
      const tableResumeRows = index === startTableIndex ? currentResumeRows : 0
      const outputFile = join(
        request.outputDirectory,
        tableExportFileName(table.schema, table.name)
      )
      const tableResult = await this.exportTable(
        connection,
        {
          connectionId: request.connectionId,
          table,
          outputFile,
          batchSize: request.batchSize,
          database: request.database,
          ...(request.where ? { where: request.where } : {})
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
    request: PostgresImportRequest,
    onProgress?: (processedRows: number, cursor?: unknown) => void,
    resume?: { lines: number; rows: number }
  ): Promise<PostgresMigrationResult> {
    const startedAt = performance.now()
    let rows = resume?.rows ?? 0

    await this.withClient(connection, request.database, async (client) => {
      const columns = await listTableColumns(client, request.table)
      const insertableColumns = columns.filter((column) => !column.isGenerated)
      if (insertableColumns.length === 0) {
        throw new Error('目标表没有可写入的列')
      }

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
        // Normalize：批次信封 {table, columns, rows} 展开为逐行 Record{Values}；
        // 逐行记录（PG/ES 导出器的行长）原样透传。
        const batch = expandJsonlRecord(record, lineNumber)
        for (const row of batch) {
          assertKnownColumns(row, columns, lineNumber)
          assertSelectedColumnsPresent(
            Object.keys(row),
            request.selectedColumns,
            lineNumber
          )
          pending.push(projectRecord(row, request.selectedColumns))
        }
        // 只在行边界 flush：批次信封整行必须一次性入库，续传游标（lines）才与已落库数据对齐。
        if (pending.length >= request.batchSize) {
          await insertBatch(client, request.table, pending, insertableColumns, request.onConflict)
          rows += pending.length
          pending = []
          onProgress?.(rows, lineNumber)
        }
      }

      if (pending.length > 0) {
        await insertBatch(client, request.table, pending, insertableColumns, request.onConflict)
        rows += pending.length
        onProgress?.(rows, lineNumber)
      }
    })

    return {
      rows,
      durationMs: performance.now() - startedAt,
      table: request.table
    }
  }

  private async withClient<T>(
    connection: ConnectionConfig,
    database: string | undefined,
    operation: (client: PostgresClientLike) => Promise<T>
  ): Promise<T> {
    const client = this.factory(buildClientConfig(connection, database))
    await client.connect()
    try {
      return await operation(client)
    } finally {
      await client.end().catch(() => undefined)
    }
  }
}

function buildClientConfig(connection: ConnectionConfig, database?: string): ClientConfig {
  const config: ClientConfig = {
    host: connection.host,
    port: connection.port,
    user: connection.username || undefined,
    password: connection.password || undefined,
    database: database || connection.database || 'postgres',
    application_name: 'data-migrator',
    connectionTimeoutMillis: 10_000
  }
  if (connection.ssl) {
    config.ssl = { rejectUnauthorized: false }
  }
  return config
}

function qualifiedTable(table: PostgresTableRef): string {
  return `${escapeIdentifier(table.schema)}.${escapeIdentifier(table.name)}`
}

function selectAllFromQualified(qualified: string, where: string | undefined): string {
  return where ? `SELECT * FROM ${qualified} WHERE ${where}` : `SELECT * FROM ${qualified}`
}

function tableKey(schema: string, name: string): string {
  return `${schema}.${name}`
}

function tableExportFileName(schema: string, name: string): string {
  const safePart = (value: string): string =>
    value.replace(/[\\/:*?"<>|]/g, '_').trim() || 'table'
  return `${safePart(schema)}.${safePart(name)}.jsonl`
}

async function writeRowsToJsonl(
  stream: NodeJS.ReadableStream,
  filePath: string,
  onRows: (rows: number) => void,
  startRows = 0,
  flags = 'w'
): Promise<void> {
  const output = createWriteStream(filePath, { encoding: 'utf8', flags })
  let rows = startRows
  try {
    for await (const row of stream) {
      const line = `${JSON.stringify(row)}\n`
      if (!output.write(line)) {
        await once(output, 'drain')
      }
      rows += 1
      onRows(rows)
    }
    output.end()
    await finished(output)
  } catch (error) {
    output.destroy()
    throw error
  }
}

async function buildResumeExportQuery(
  client: PostgresClientLike,
  table: PostgresTableRef,
  offset: number,
  where: string | undefined
): Promise<string> {
  const columns = await listTableColumns(client, table)
  const primaryKeys = columns.filter((column) => column.isPrimaryKey).map((column) => column.name)
  const orderBy = primaryKeys.length > 0
    ? primaryKeys.map(escapeIdentifier).join(', ')
    : 'ctid'
  const whereClause = where ? ` WHERE ${where}` : ''
  return `SELECT * FROM ${qualifiedTable(table)}${whereClause} ORDER BY ${orderBy} OFFSET ${offset}`
}

async function listTableColumns(
  client: PostgresClientLike,
  table: PostgresTableRef
): Promise<PostgresColumn[]> {
  const result = await client.query<{
    column_name: string
    data_type: string
    is_nullable: boolean
    is_primary_key: boolean
    is_generated: string
  }>(
    `
      SELECT
        cols.column_name AS column_name,
        cols.data_type AS data_type,
        cols.is_nullable = 'YES' AS is_nullable,
        EXISTS (
          SELECT 1
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name = tc.constraint_name
            AND kcu.table_schema = tc.table_schema
            AND kcu.table_name = tc.table_name
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = cols.table_schema
            AND tc.table_name = cols.table_name
            AND kcu.column_name = cols.column_name
        ) AS is_primary_key,
        cols.is_generated AS is_generated
      FROM information_schema.columns cols
      WHERE cols.table_schema = $1 AND cols.table_name = $2
      ORDER BY cols.ordinal_position
    `,
    [table.schema, table.name]
  )

  if (result.rows.length === 0) {
    throw new Error(`表不存在：${qualifiedTable(table)}`)
  }

  return result.rows.map((row: {
    column_name: string
    data_type: string
    is_nullable: boolean
    is_primary_key: boolean
    is_generated: string
  }) => ({
    name: row.column_name,
    dataType: row.data_type,
    isNullable: row.is_nullable,
    isPrimaryKey: row.is_primary_key,
    isGenerated: row.is_generated === 'ALWAYS'
  }))
}

function assertKnownColumns(
  row: Record<string, unknown>,
  columns: PostgresColumn[],
  lineNumber: number
): void {
  const known = new Set(columns.map((column) => column.name))
  const unknown = Object.keys(row).filter((key) => !known.has(key))
  if (unknown.length > 0) {
    throw new Error(`第 ${lineNumber} 行包含目标表不存在的列：${unknown.join(', ')}`)
  }
}

async function insertBatch(
  client: PostgresClientLike,
  table: PostgresTableRef,
  rows: Array<Record<string, unknown>>,
  columns: PostgresColumn[],
  onConflict: PostgresConflictAction
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
    const valueGroups: string[] = []
    const values: unknown[] = []
    let parameterIndex = 1

    for (const row of batch) {
      const placeholders: string[] = []
      for (const key of keys) {
        placeholders.push(`$${parameterIndex}`)
        parameterIndex += 1
        values.push(toPgValue(row[key]))
      }
      valueGroups.push(`(${placeholders.join(', ')})`)
    }

    const conflictSuffix = onConflict === 'skip' ? ' ON CONFLICT DO NOTHING' : ''
    const sql =
      `INSERT INTO ${qualifiedTable(table)} (${keys.map(escapeIdentifier).join(', ')}) ` +
      `VALUES ${valueGroups.join(', ')}${conflictSuffix}`
    await client.query(sql, values)
  }
}

function toPgValue(value: unknown): unknown {
  if (value === undefined) {
    return null
  }
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value)
  }
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'PostgreSQL 操作失败'
}

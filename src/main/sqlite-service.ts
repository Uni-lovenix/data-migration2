import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { finished } from 'node:stream/promises'

import Database from 'better-sqlite3'

import type {
  ConnectionConfig,
  SQLiteBatchExportRequest,
  SQLiteBatchMigrationResult,
  SQLiteColumn,
  SQLiteConnectionTestResult,
  SQLiteCountRowsRequest,
  SQLiteExportRequest,
  SQLiteMigrationResult,
  SQLiteTable,
  SQLiteTableRef
} from '../shared/types'
import { TaskCancelledError } from './task-errors'

export interface SQLiteStatementLike {
  all: (...params: any[]) => unknown[]
  iterate: (...params: any[]) => IterableIterator<unknown>
}

export interface SQLiteDatabaseLike {
  prepare: (sql: string) => SQLiteStatementLike
  close: () => unknown
}

export type SQLiteDatabaseFactory = (filePath: string) => SQLiteDatabaseLike

export interface SQLiteBatchExportCursor {
  tableIndex: number
  rows: number
}

interface SQLiteColumnInfo extends SQLiteColumn {
  hidden: number
}

export class SQLiteService {
  private readonly factory: SQLiteDatabaseFactory

  constructor(factory: SQLiteDatabaseFactory = defaultSQLiteDatabaseFactory) {
    this.factory = factory
  }

  async testConnection(connection: ConnectionConfig): Promise<SQLiteConnectionTestResult> {
    try {
      const version = await this.withDatabase(connection, async (database) => {
        const rows = database
          .prepare('SELECT sqlite_version() AS version')
          .all() as Array<{ version: unknown }>
        return String(rows[0]?.version ?? '')
      })
      return { ok: true, serverVersion: version }
    } catch (error) {
      return { ok: false, message: sqliteErrorMessage(error, connection) }
    }
  }

  async listTables(connection: ConnectionConfig): Promise<SQLiteTable[]> {
    return this.withDatabase(connection, async (database) => {
      const rows = database
        .prepare(
          `SELECT name
           FROM main.sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`
        )
        .all() as Array<{ name: unknown }>

      return rows.map((row) => {
        const name = String(row.name)
        return {
          schema: 'main',
          name,
          columns: listTableColumns(database, name).map(toPublicColumn),
          estimatedRows: null
        }
      })
    })
  }

  async countRows(
    connection: ConnectionConfig,
    request: SQLiteCountRowsRequest
  ): Promise<number> {
    return this.withDatabase(connection, async (database) => {
      assertTableExists(database, request.table)
      const rows = database
        .prepare(
          `SELECT COUNT(1) AS count FROM ${qualifiedTable(request.table)}`
        )
        .all() as Array<{ count: unknown }>
      const count = Number(rows[0]?.count ?? 0)
      return Number.isFinite(count) ? count : 0
    })
  }

  async exportTable(
    connection: ConnectionConfig,
    request: SQLiteExportRequest,
    onProgress?: (processedRows: number, cursor?: unknown) => void,
    resumeRows = 0
  ): Promise<SQLiteMigrationResult> {
    const startedAt = performance.now()
    const temporaryPath = `${request.outputFile}.part`
    let rows = resumeRows

    try {
      await mkdir(dirname(request.outputFile), { recursive: true })
      await this.withDatabase(connection, async (database) => {
        const columns = listTableColumns(database, request.table.name).filter(
          (column) => column.hidden === 0
        )
        if (columns.length === 0) {
          throw new Error(`表不存在或没有可导出的列：${qualifiedTable(request.table)}`)
        }
        const columnNames = columns.map((column) => column.name)
        const output = createWriteStream(temporaryPath, {
          encoding: 'utf8',
          flags: resumeRows > 0 ? 'a' : 'w'
        })
        const statement = database.prepare(
          buildSelectSql(request.table, columns, resumeRows)
        )

        try {
          let pending: unknown[][] = []
          for (const raw of statement.iterate()) {
            const row = raw as Record<string, unknown>
            pending.push(columnNames.map((name) => row[name]))
            if (pending.length >= request.batchSize) {
              const line = `${stringifyEnvelope(request.table, columnNames, pending)}\n`
              if (!output.write(line)) {
                await once(output, 'drain')
              }
              rows += pending.length
              pending = []
              onProgress?.(rows, rows)
            }
          }

          if (pending.length > 0) {
            const line = `${stringifyEnvelope(request.table, columnNames, pending)}\n`
            if (!output.write(line)) {
              await once(output, 'drain')
            }
            rows += pending.length
          }

          output.end()
          await finished(output)
          onProgress?.(rows, rows)
        } catch (error) {
          if (error instanceof TaskCancelledError) {
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
    request: SQLiteBatchExportRequest,
    onProgress?: (processedRows: number, cursor?: unknown) => void,
    resume?: SQLiteBatchExportCursor
  ): Promise<SQLiteBatchMigrationResult> {
    const startedAt = performance.now()
    const startTableIndex = Math.max(
      0,
      Math.min(resume?.tableIndex ?? 0, request.tables.length)
    )
    const currentResumeRows =
      startTableIndex < request.tables.length && resume?.tableIndex === startTableIndex
        ? resume.rows
        : 0
    let totalRows = startTableIndex < request.tables.length ? currentResumeRows : 0
    let bytes = 0
    const tableResults: SQLiteMigrationResult[] = []

    for (let index = startTableIndex; index < request.tables.length; index += 1) {
      const table = request.tables[index]
      if (!table) {
        continue
      }
      const tableResumeRows = index === startTableIndex ? currentResumeRows : 0
      const outputFile = join(
        request.outputDirectory,
        sqliteExportFileName(table.schema, table.name)
      )
      const tableResult = await this.exportTable(
        connection,
        {
          connectionId: request.connectionId,
          table,
          outputFile,
          batchSize: request.batchSize
        },
        (processed, cursor) => {
          const cursorRows = Number(
            cursor && typeof cursor === 'object' && 'rows' in cursor
              ? (cursor as { rows?: unknown }).rows
              : processed
          )
          onProgress?.(totalRows - tableResumeRows + processed, {
            tableIndex: index,
            rows: Number.isFinite(cursorRows) ? cursorRows : processed
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

  private async withDatabase<T>(
    connection: ConnectionConfig,
    operation: (database: SQLiteDatabaseLike) => Promise<T>
  ): Promise<T> {
    const database = this.factory(sqliteFilePath(connection))
    try {
      return await operation(database)
    } finally {
      database.close()
    }
  }
}

function defaultSQLiteDatabaseFactory(filePath: string): SQLiteDatabaseLike {
  return new Database(filePath, {
    readonly: true,
    fileMustExist: true,
    timeout: 10_000
  })
}

function sqliteFilePath(connection: ConnectionConfig): string {
  const filePath = (connection.filePath ?? connection.host).trim()
  if (filePath.length === 0) {
    throw new Error('SQLite 数据库文件路径不能为空')
  }
  return filePath
}

function assertTableExists(database: SQLiteDatabaseLike, table: SQLiteTableRef): void {
  const rows = database
    .prepare(
      `SELECT 1 AS found
       FROM ${quoteIdentifier(table.schema)}.sqlite_master
       WHERE type = 'table' AND name = ?`
    )
    .all(table.name)
  if (rows.length === 0) {
    throw new Error(`表不存在：${qualifiedTable(table)}`)
  }
}

function listTableColumns(database: SQLiteDatabaseLike, table: string): SQLiteColumnInfo[] {
  const rows = database
    .prepare(
      `SELECT
         name,
         type,
         "notnull" AS not_null,
         pk,
         hidden
       FROM pragma_table_xinfo(?)
       ORDER BY cid`
    )
    .all(table) as Array<{
    name: unknown
    type: unknown
    not_null: unknown
    pk: unknown
    hidden: unknown
  }>

  return rows.map((row) => ({
    name: String(row.name),
    dataType: String(row.type ?? ''),
    isNullable: Number(row.not_null) === 0,
    isPrimaryKey: Number(row.pk) > 0,
    isGenerated: Number(row.hidden) === 2 || Number(row.hidden) === 3,
    hidden: Number(row.hidden)
  }))
}

function toPublicColumn(column: SQLiteColumnInfo): SQLiteColumn {
  const { hidden: _hidden, ...publicColumn } = column
  return publicColumn
}

function buildSelectSql(
  table: SQLiteTableRef,
  columns: SQLiteColumnInfo[],
  offset: number
): string {
  const primaryKeys = columns.filter((column) => column.isPrimaryKey)
  const orderBy =
    primaryKeys.length > 0
      ? primaryKeys.map((column) => quoteIdentifier(column.name)).join(', ')
      : 'rowid'
  const offsetClause = offset > 0 ? ` LIMIT -1 OFFSET ${Math.max(0, Math.trunc(offset))}` : ''
  return (
    `SELECT ${columns.map((column) => quoteIdentifier(column.name)).join(', ')} ` +
    `FROM ${qualifiedTable(table)} ORDER BY ${orderBy}${offsetClause}`
  )
}

function qualifiedTable(table: SQLiteTableRef): string {
  return `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function stringifyEnvelope(
  table: SQLiteTableRef,
  columns: string[],
  rows: unknown[][]
): string {
  return JSON.stringify({ table, columns, rows }, jsonReplacer)
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

function sqliteExportFileName(schema: string, table: string): string {
  const safePart = (value: string): string =>
    value.replace(/[\\/:*?"<>|]/g, '_').trim() || 'table'
  return `${safePart(schema)}.${safePart(table)}.jsonl`
}

export function sqliteErrorMessage(
  error: unknown,
  connection?: ConnectionConfig
): string {
  const record = error as { code?: unknown; message?: unknown }
  const code = typeof record?.code === 'string' ? record.code : undefined
  const base =
    typeof record?.message === 'string' && record.message.length > 0
      ? record.message
      : 'SQLite 操作失败'
  const suffix = code && !base.includes(code) ? ` [${code}]` : ''
  const hint =
    connection && code === 'SQLITE_CANTOPEN'
      ? `（无法打开数据库：${connection.filePath ?? connection.host}）`
      : ''
  return `${base}${suffix}${hint}`
}

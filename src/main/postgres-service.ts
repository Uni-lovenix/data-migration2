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
  DirectMigrationResult,
  PostgresColumn,
  PostgresConflictAction,
  PostgresConnectionTestResult,
  PostgresBatchExportRequest,
  PostgresBatchMigrationResult,
  PostgresCountRowsRequest,
  PostgresDirectRequest,
  PostgresExportRequest,
  PostgresImportRequest,
  PostgresMigrationResult,
  RollbackConflictPolicy,
  RollbackResult,
  PostgresTable,
  PostgresTableRef
} from '../shared/types'
import {
  assertSelectedColumnsPresent,
  projectRecord
} from '../shared/column-projection'
import { transformRecord } from '../shared/type-conversion'
import { expandJsonlRecord } from '../shared/jsonl-record'
import { RollbackConflictError, TaskCancelledError } from './task-errors'
import {
  UndoJournal,
  readUndoJournal,
  type UndoBatchRecord,
  type UndoKeyEntry
} from './undo-journal'

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

  async previewTable(
    connection: ConnectionConfig,
    table: PostgresTableRef,
    limit: number
  ): Promise<Array<Record<string, unknown>>> {
    return this.withClient(connection, undefined, async (client) => {
      const result = await client.query(
        `SELECT * FROM ${qualifiedTable(table)} LIMIT $1`,
        [Math.max(1, Math.min(limit, 1000))]
      )
      return result.rows as Array<Record<string, unknown>>
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
    let tableCreated = false

    await this.withClient(connection, request.database, async (client) => {
      if (request.createTable) {
        // 目标表不存在时，按导入数据推断/人工重定义的 DDL 先建表，再写入。
        if (!(await tableExists(client, request.table))) {
          if (!request.tableDefinition) {
            throw new Error(
              `表不存在：${qualifiedTable(request.table)}，且未提供建表 DDL`
            )
          }
          if (request.table.schema) {
            await client.query(
              `CREATE SCHEMA IF NOT EXISTS ${escapeIdentifier(request.table.schema)}`
            )
          }
          await client.query(request.tableDefinition)
          tableCreated = true
        }
      }
      const columns = await listTableColumns(client, request.table)
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
          const transformed = transformRecord(
            projectRecord(row, request.selectedColumns),
            request.fieldTransforms,
            targetTypes,
            lineNumber
          )
          assertKnownColumns(transformed, columns, lineNumber)
          pending.push(transformed)
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
      table: request.table,
      ...(tableCreated ? { tableCreated: true } : {})
    }
  }

  /**
   * 直连迁移：源表流式读取，按批次直接写入目标表，本地不落数据文件。
   *
   * 每个批次是一个目标端事务；批次提交前先把撤销信息 fsync 落盘，
   * 因此整任务可以被回滚（见 rollbackDirectMigration）。
   */
  async directMigrateTable(
    source: ConnectionConfig,
    target: ConnectionConfig,
    request: PostgresDirectRequest,
    control: PostgresDirectControl,
    onProgress?: (processedRows: number, cursor?: unknown) => void
  ): Promise<DirectMigrationResult> {
    const startedAt = performance.now()
    const captureUndo = request.rollbackOn !== 'none'
    let written = 0
    let skipped = 0
    let tableCreated = false

    const sourceClient = this.factory(buildClientConfig(source, request.database))
    const targetClient = this.factory(
      buildClientConfig(target, request.targetDatabase)
    )
    const journal = captureUndo
      ? new UndoJournal(control.journalPath, control.taskId)
      : undefined

    await sourceClient.connect()
    try {
      await targetClient.connect()
      try {
        const sourceColumns = await listTableColumns(sourceClient, request.table)
        const sourceNames = new Set(sourceColumns.map((column) => column.name))
        const columns =
          request.selectedColumns && request.selectedColumns.length > 0
            ? [...request.selectedColumns]
            : sourceColumns.filter((column) => !column.isGenerated).map((column) => column.name)
        const missing = columns.filter((column) => !sourceNames.has(column))
        if (missing.length > 0) {
          throw new Error(`源表不存在的列：${missing.join(', ')}`)
        }
        if (columns.length === 0) {
          throw new Error('没有可迁移的列')
        }

        if (request.createTable && !(await tableExists(targetClient, request.targetTable))) {
          if (!request.tableDefinition) {
            throw new Error(
              `表不存在：${qualifiedTable(request.targetTable)}，且未提供建表 DDL`
            )
          }
          if (request.targetTable.schema) {
            await targetClient.query(
              `CREATE SCHEMA IF NOT EXISTS ${escapeIdentifier(request.targetTable.schema)}`
            )
          }
          await targetClient.query(request.tableDefinition)
          tableCreated = true
        }

        const targetColumns = await listTableColumns(targetClient, request.targetTable)
        const insertable = targetColumns.filter((column) => !column.isGenerated)
        const insertableNames = new Set(insertable.map((column) => column.name))
        const unknown = columns.filter((column) => !insertableNames.has(column))
        if (unknown.length > 0) {
          throw new Error(`目标表不存在的列：${unknown.join(', ')}`)
        }
        const targetTypes = new Map(
          insertable.map((column) => [column.name, column.dataType])
        )
        const primaryKeys = targetColumns
          .filter((column) => column.isPrimaryKey)
          .map((column) => column.name)
        if (primaryKeys.length === 0) {
          if (captureUndo) {
            throw new Error(
              '目标表没有主键，无法记录撤销日志；请把回滚策略设为"不记录"，或改用带主键的目标表'
            )
          }
          if (request.conflictPolicy === 'overwrite') {
            throw new Error('覆盖写入需要目标表包含主键')
          }
        }

        if (journal) {
          await journal.open()
        }

        const query = selectColumnsFromQualified(
          qualifiedTable(request.table),
          columns.map(escapeIdentifier),
          request.where
        )
        const stream = sourceClient.query(new QueryStream(query))
        let pending: Array<Record<string, unknown>> = []
        let processed = 0
        let sequence = 0

        const flush = async (): Promise<void> => {
          if (pending.length === 0) {
            return
          }
          const batch = pending
          pending = []
          sequence += 1
          await targetClient.query('BEGIN')
          try {
            const batchResult = await flushDirectBatch(
              targetClient,
              request,
              columns,
              primaryKeys,
              insertable.map((column) => column.name),
              batch,
              captureUndo
            )
            if (journal) {
              await journal.recordBatch({
                sequence,
                mode: request.conflictPolicy === 'overwrite' ? 'overwrite' : 'insert',
                target: request.targetTable,
                keyFields: primaryKeys,
                keys: batchResult.keys,
                capturedAt: new Date().toISOString()
              })
            }
            await targetClient.query('COMMIT')
            if (journal) {
              await journal.markCommitted(
                sequence,
                batchResult.written,
                batchResult.skipped
              )
            }
            written += batchResult.written
            skipped += batchResult.skipped
            processed += batch.length
            onProgress?.(processed, { rows: processed })
          } catch (error) {
            await targetClient.query('ROLLBACK').catch(() => undefined)
            throw error
          }
        }

        for await (const raw of stream) {
          const record = raw as Record<string, unknown>
          pending.push(
            transformRecord(
              record,
              request.fieldTransforms,
              targetTypes,
              processed + pending.length + 1
            )
          )
          if (pending.length >= request.batchSize) {
            await flush()
          }
        }
        await flush()

        return {
          rows: written,
          skipped,
          durationMs: performance.now() - startedAt,
          table: request.table,
          targetTable: request.targetTable,
          ...(journal ? { undoJournalPath: journal.path } : {}),
          ...(tableCreated ? { tableCreated: true } : {})
        }
      } finally {
        await journal?.close()
        await targetClient.end().catch(() => undefined)
      }
    } finally {
      await sourceClient.end().catch(() => undefined)
    }
  }

  /**
   * 回滚一次直连迁移任务：逆序重放撤销日志，删除本次写入并恢复被覆盖的原值。
   * 回滚过程幂等，可重复执行；被第三方修改过的行按冲突策略处理。
   */
  async rollbackDirectMigration(
    target: ConnectionConfig,
    request: PostgresRollbackOptions,
    onProgress?: (processedBatches: number, cursor?: unknown) => void
  ): Promise<RollbackResult> {
    const startedAt = performance.now()
    const contents = await readUndoJournal(request.journalPath)
    const batches = [...contents.batches].sort((a, b) => b.sequence - a.sequence)
    let deletedRows = 0
    let restoredRows = 0
    let skippedConflicts = 0

    // abort 模式先做只读预检：只要存在第三方修改就整体中止，不在回滚中途留下半成品。
    if (request.conflictPolicy !== 'skip') {
      await this.withClient(target, request.targetDatabase, async (client) => {
        let conflicts = 0
        for (const batch of batches) {
          const entries = batch.keys.filter((entry) => entry.rowHash !== null)
          if (entries.length === 0) {
            continue
          }
          await client.query('BEGIN')
          try {
            await createUndoKeysTable(client)
            await insertUndoKeys(client, entries)
            conflicts += await countBatchConflicts(client, batch)
          } finally {
            await client.query('ROLLBACK').catch(() => undefined)
          }
        }
        if (conflicts > 0) {
          throw new RollbackConflictError(conflicts, '回滚目标')
        }
      })
    }

    await this.withClient(target, request.targetDatabase, async (client) => {
      let processedBatches = 0
      for (const batch of batches) {
        const entries = batch.keys.filter((entry) => entry.rowHash !== null)
        if (entries.length > 0) {
          await client.query('BEGIN')
          try {
            await createUndoKeysTable(client)
            await insertUndoKeys(client, entries)

            const keyExpression = keyHashExpression('x', batch.keyFields)
            const conflicts = await countBatchConflicts(client, batch)
            if (conflicts > 0 && request.conflictPolicy !== 'skip') {
              throw new RollbackConflictError(conflicts, qualifiedTable(batch.target))
            }
            skippedConflicts += conflicts

            const deleted = await client.query(
              `
                DELETE FROM ${qualifiedTable(batch.target)} x
                USING dm_undo_keys u
                WHERE ${keyExpression} = u.key_hash
                  AND md5(x::text) = u.row_hash
                  AND u.pre_image IS NULL
              `
            )
            deletedRows += deleted.rowCount ?? 0

            const restorable = entries.filter(
              (entry) => entry.preImage !== null && entry.rowHash !== null
            )
            for (const entry of restorable) {
              const preImage = entry.preImage as Record<string, unknown>
              const columns = Object.keys(preImage)
              if (columns.length === 0) {
                continue
              }
              const assignments = columns
                .map((column, index) => `${escapeIdentifier(column)} = $${index + 2}`)
                .join(', ')
              const restored = await client.query(
                `
                  UPDATE ${qualifiedTable(batch.target)} x
                  SET ${assignments}
                  WHERE ${keyExpression} = $1
                    AND md5(x::text) = $${columns.length + 2}
                `,
                [
                  entry.keyHash,
                  ...columns.map((column) => toRestoreValue(preImage[column])),
                  entry.rowHash
                ]
              )
              restoredRows += restored.rowCount ?? 0
            }

            await client.query('COMMIT')
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined)
            throw error
          }
        }
        processedBatches += 1
        onProgress?.(processedBatches, { batches: processedBatches })
      }

      if (request.dropCreatedTarget && request.targetTable) {
        await client.query(
          `DROP TABLE IF EXISTS ${qualifiedTable(request.targetTable)}`
        )
      }
    })

    return {
      taskId: request.taskId,
      deletedRows,
      restoredRows,
      skippedConflicts,
      durationMs: performance.now() - startedAt
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

async function tableExists(
  client: PostgresClientLike,
  table: PostgresTableRef
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = $2
      ) AS exists
    `,
    [table.schema, table.name]
  )
  return result.rows[0]?.exists === true
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

export interface PostgresDirectControl {
  taskId: string
  /** 撤销日志文件路径（本地控制文件，不是数据文件）。 */
  journalPath: string
}

export interface PostgresRollbackOptions {
  taskId: string
  journalPath: string
  conflictPolicy: RollbackConflictPolicy
  targetDatabase?: string
  targetTable?: PostgresTableRef
  dropCreatedTarget?: boolean
}

interface DirectBatchResult {
  written: number
  skipped: number
  keys: UndoKeyEntry[]
}

function selectColumnsFromQualified(
  qualified: string,
  columns: string[],
  where: string | undefined
): string {
  const projection = columns.length > 0 ? columns.join(', ') : '*'
  return where
    ? `SELECT ${projection} FROM ${qualified} WHERE ${where}`
    : `SELECT ${projection} FROM ${qualified}`
}

/** md5(ROW(主键列...)) —— 写入与回滚共用同一表达式，避免类型转换不一致。 */
function keyHashExpression(alias: string, keyFields: string[]): string {
  const tuple = keyFields
    .map((field) => `${alias}.${escapeIdentifier(field)}`)
    .join(', ')
  return `md5(ROW(${tuple})::text)`
}

function chunkRows<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = []
  const effective = Math.max(1, size)
  for (let index = 0; index < rows.length; index += effective) {
    chunks.push(rows.slice(index, index + effective))
  }
  return chunks
}

function buildValueGroups(
  rows: Array<Record<string, unknown>>,
  columns: string[]
): { valueGroups: string; values: unknown[] } {
  const groups: string[] = []
  const values: unknown[] = []
  let parameterIndex = 1
  for (const row of rows) {
    const placeholders = columns.map(() => `$${parameterIndex++}`)
    groups.push(`(${placeholders.join(', ')})`)
    for (const column of columns) {
      values.push(toPgValue(row[column]))
    }
  }
  return { valueGroups: groups.join(', '), values }
}

/**
 * 写入一个批次的直连数据。
 * 目标端返回的 key_hash / row_hash 都来自数据库自身表达式，
 * 回滚时用同一表达式匹配，不会因驱动类型转换而漂移。
 */
async function flushDirectBatch(
  client: PostgresClientLike,
  request: PostgresDirectRequest,
  columns: string[],
  primaryKeys: string[],
  insertableColumns: string[],
  rows: Array<Record<string, unknown>>,
  captureUndo: boolean
): Promise<DirectBatchResult> {
  const target = qualifiedTable(request.targetTable)
  const columnList = columns.map(escapeIdentifier).join(', ')
  const mode = request.conflictPolicy === 'overwrite' ? 'overwrite' : 'insert'
  const hasKeys = primaryKeys.length > 0
  const keyExpression = hasKeys ? keyHashExpression('x', primaryKeys) : undefined
  const returning = keyExpression
    ? ` RETURNING ${keyExpression} AS key_hash, md5(x::text) AS row_hash`
    : ''
  const preImages = new Map<string, Record<string, unknown>>()
  const keys: UndoKeyEntry[] = []
  let written = 0
  let skipped = 0

  for (const batch of chunkRows(rows, Math.floor(MAX_QUERY_PARAMS / columns.length))) {
    if (mode === 'overwrite' && captureUndo && hasKeys) {
      const captured = await selectPreImages(
        client,
        request.targetTable,
        insertableColumns,
        primaryKeys,
        batch
      )
      for (const [hash, image] of captured) {
        preImages.set(hash, image)
      }
    }

    const { valueGroups, values } = buildValueGroups(batch, columns)
    let sql: string
    if (mode === 'insert') {
      sql =
        `INSERT INTO ${target} AS x (${columnList}) VALUES ${valueGroups} ` +
        `ON CONFLICT DO NOTHING${returning}`
    } else {
      const updates = columns
        .filter((column) => !primaryKeys.includes(column))
        .map((column) => `${escapeIdentifier(column)} = EXCLUDED.${escapeIdentifier(column)}`)
      if (updates.length === 0 && primaryKeys[0]) {
        const key = escapeIdentifier(primaryKeys[0])
        updates.push(`${key} = EXCLUDED.${key}`)
      }
      const conflictTarget = primaryKeys.map(escapeIdentifier).join(', ')
      sql =
        `INSERT INTO ${target} AS x (${columnList}) VALUES ${valueGroups} ` +
        `ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updates.join(', ')}${returning}`
    }

    const result = await client.query<{ key_hash: string; row_hash: string }>(
      sql,
      values
    )
    if (mode === 'insert') {
      written += result.rows.length
      skipped += batch.length - result.rows.length
    } else {
      written += batch.length
    }
    for (const row of result.rows) {
      keys.push({
        keyHash: row.key_hash,
        rowHash: row.row_hash,
        preImage: preImages.get(row.key_hash) ?? null
      })
    }
  }

  return { written, skipped, keys }
}

async function selectPreImages(
  client: PostgresClientLike,
  table: PostgresTableRef,
  insertableColumns: string[],
  primaryKeys: string[],
  rows: Array<Record<string, unknown>>
): Promise<Map<string, Record<string, unknown>>> {
  const target = qualifiedTable(table)
  const columnList = insertableColumns
    .map((column) => `x.${escapeIdentifier(column)}`)
    .join(', ')
  const keyList = primaryKeys.map((key) => `x.${escapeIdentifier(key)}`).join(', ')
  const tuples: string[] = []
  const values: unknown[] = []
  let parameterIndex = 1
  for (const row of rows) {
    const placeholders = primaryKeys.map(() => `$${parameterIndex++}`)
    tuples.push(`(${placeholders.join(', ')})`)
    for (const key of primaryKeys) {
      values.push(toPgValue(row[key]))
    }
  }

  const result = await client.query<Record<string, unknown>>(
    `
      SELECT ${columnList}, ${keyHashExpression('x', primaryKeys)} AS __dm_key_hash
      FROM ${target} x
      WHERE (${keyList}) IN (${tuples.join(', ')})
      FOR UPDATE
    `,
    values
  )

  const images = new Map<string, Record<string, unknown>>()
  for (const row of result.rows) {
    const image: Record<string, unknown> = {}
    for (const column of insertableColumns) {
      image[column] = toJsonSafeValue(row[column])
    }
    images.set(String(row.__dm_key_hash), image)
  }
  return images
}

async function createUndoKeysTable(client: PostgresClientLike): Promise<void> {
  await client.query(`
    CREATE TEMP TABLE IF NOT EXISTS dm_undo_keys (
      key_hash text PRIMARY KEY,
      row_hash text NOT NULL,
      pre_image jsonb
    ) ON COMMIT DROP
  `)
}

/**
 * 统计当前目标端与撤销日志"键相同但行内容已变"的行数。
 * 依赖调用方已把本批次写入 dm_undo_keys 临时表。
 */
async function countBatchConflicts(
  client: PostgresClientLike,
  batch: UndoBatchRecord
): Promise<number> {
  const keyExpression = keyHashExpression('x', batch.keyFields)
  const result = await client.query<{ conflicts: number }>(
    `
      SELECT count(*)::int AS conflicts
      FROM ${qualifiedTable(batch.target)} x
      JOIN dm_undo_keys u ON ${keyExpression} = u.key_hash
      WHERE md5(x::text) <> u.row_hash
    `
  )
  return result.rows[0]?.conflicts ?? 0
}

async function insertUndoKeys(
  client: PostgresClientLike,
  entries: UndoKeyEntry[]
): Promise<void> {
  for (const batch of chunkRows(entries, 1000)) {
    const placeholders: string[] = []
    const values: unknown[] = []
    let parameterIndex = 1
    for (const entry of batch) {
      placeholders.push(`($${parameterIndex++}, $${parameterIndex++}, $${parameterIndex++})`)
      values.push(
        entry.keyHash,
        entry.rowHash,
        entry.preImage ? JSON.stringify(entry.preImage) : null
      )
    }
    await client.query(
      `INSERT INTO dm_undo_keys (key_hash, row_hash, pre_image) VALUES ${placeholders.join(', ')}`,
      values
    )
  }
}

function toJsonSafeValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return { __dmBytea: value.toString('hex') }
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafeValue(item))
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = toJsonSafeValue(item)
    }
    return output
  }
  return value
}

function toRestoreValue(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const marker = (value as { __dmBytea?: unknown }).__dmBytea
    if (typeof marker === 'string') {
      return Buffer.from(marker, 'hex')
    }
  }
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'PostgreSQL 操作失败'
}

import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { finished } from 'node:stream/promises'

import {
  auth as hiveAuth,
  connections as hiveConnections,
  HiveClient,
  HiveUtils,
  thrift
} from 'hive-driver'

import type {
  ConnectionConfig,
  HiveConnectionTestResult,
  HiveCountRowsRequest,
  HiveExportRequest,
  HiveImportRequest,
  HiveMigrationResult,
  HiveTable
} from '../shared/types'
import { expandJsonlRecord } from '../shared/jsonl-record'
import { TaskCancelledError } from './task-errors'

export interface HiveQueryResult {
  columns: string[]
  rows: Array<Record<string, unknown>>
}

export interface HiveSessionLike {
  query: (statement: string) => Promise<HiveQueryResult>
  close: () => Promise<void>
}

export type HiveSessionFactory = (
  connection: ConnectionConfig
) => Promise<HiveSessionLike>

export class HiveService {
  private readonly sessionFactory: HiveSessionFactory

  constructor(sessionFactory: HiveSessionFactory = openDriverSession) {
    this.sessionFactory = sessionFactory
  }

  async testConnection(connection: ConnectionConfig): Promise<HiveConnectionTestResult> {
    try {
      const session = await this.sessionFactory(connection)
      try {
        const result = await session.query('SELECT version() AS version')
        return {
          ok: true,
          serverVersion: String(result.rows[0]?.version ?? ''),
          transportMode: connection.transportMode ?? 'binary'
        }
      } finally {
        await session.close().catch(() => undefined)
      }
    } catch (error) {
      return {
        ok: false,
        transportMode: connection.transportMode ?? 'binary',
        message: hiveErrorMessage(error, connection)
      }
    }
  }

  async listDatabases(connection: ConnectionConfig): Promise<string[]> {
    return this.withSession(connection, async (session) => {
      const result = await session.query('SHOW DATABASES')
      return result.rows.map((row) => String(firstValue(row) ?? '')).filter(Boolean)
    })
  }

  async listTables(connection: ConnectionConfig, database: string): Promise<HiveTable[]> {
    const target = resolveDatabase(connection, database)
    return this.withSession(connection, async (session) => {
      const result = await session.query(`SHOW TABLES IN ${quoteIdentifier(target)}`)
      return result.rows
        .map((row) => String(firstValue(row) ?? ''))
        .filter(Boolean)
        .map((name) => ({ database: target, name }))
    })
  }

  async countRows(
    connection: ConnectionConfig,
    request: HiveCountRowsRequest
  ): Promise<number> {
    return this.withSession(connection, async (session) => {
      const result = await session.query(
        `SELECT COUNT(1) AS count FROM ${qualifiedTable(request.table)}`
      )
      const count = Number(result.rows[0]?.count ?? 0)
      return Number.isFinite(count) ? count : 0
    })
  }

  async exportTable(
    connection: ConnectionConfig,
    request: HiveExportRequest,
    onProgress?: (processedRows: number, cursor?: unknown) => void,
    resumeRows = 0
  ): Promise<HiveMigrationResult> {
    const startedAt = performance.now()
    const temporaryPath = `${request.outputFile}.part`
    let rows = resumeRows

    try {
      await mkdir(dirname(request.outputFile), { recursive: true })
      await this.withSession(connection, async (session) => {
        const output = createWriteStream(temporaryPath, {
          encoding: 'utf8',
          flags: resumeRows > 0 ? 'a' : 'w'
        })
        try {
          let columns =
            resumeRows > 0
              ? (
                  await session.query(
                    `SELECT * FROM ${qualifiedTable(request.table)} LIMIT 0`
                  )
                ).columns
              : []

          while (true) {
            const page = await session.query(
              `SELECT * FROM ${qualifiedTable(request.table)} ` +
                `LIMIT ${request.batchSize} OFFSET ${rows}`
            )
            if (columns.length === 0) {
              columns = page.columns
            }
            if (page.rows.length === 0) {
              break
            }

            const batchRows = page.rows.map((row) =>
              columns.map((column) => normalizeHiveValue(rowValue(row, column)))
            )
            const line = `${stringifyEnvelope(request.table, columns, batchRows)}\n`
            if (!output.write(line)) {
              await once(output, 'drain')
            }
            rows += page.rows.length
            onProgress?.(rows, rows)

            if (page.rows.length < request.batchSize) {
              break
            }
          }

          output.end()
          await finished(output)
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

  async importJsonl(
    connection: ConnectionConfig,
    request: HiveImportRequest,
    onProgress?: (processedRows: number, cursor?: unknown) => void,
    resume?: { lines: number; rows: number }
  ): Promise<HiveMigrationResult> {
    const startedAt = performance.now()
    let rows = resume?.rows ?? 0
    let skipped = 0
    const warnings: string[] = []

    await this.withSession(connection, async (session) => {
      const targetColumns = await describeTable(session, request.table)
      if (targetColumns.length === 0) {
        throw new Error(`目标表没有可写入的列：${qualifiedTable(request.table)}`)
      }
      const targetTypes = new Map(targetColumns.map((column) => [column.name, column.dataType]))
      const input = createReadStream(request.inputFile, { encoding: 'utf8' })
      const lines = createInterface({ input, crlfDelay: Infinity })
      let pending: Array<Record<string, unknown>> = []
      let lineNumber = 0
      let lastProgressLine = resume?.lines ?? 0

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
          warnings.push(`第 ${lineNumber} 行不是有效 JSON，已跳过`)
          skipped += 1
          continue
        }

        let expanded: Array<Record<string, unknown>>
        try {
          expanded = expandJsonlRecord(record, lineNumber)
        } catch (error) {
          warnings.push(errorMessage(error))
          skipped += 1
          continue
        }

        for (const row of expanded) {
          const unknownColumns = Object.keys(row).filter((column) => !targetTypes.has(column))
          if (unknownColumns.length > 0) {
            warnings.push(
              `第 ${lineNumber} 行包含目标表不存在的列：${unknownColumns.join(', ')}，已跳过`
            )
            skipped += 1
            continue
          }
          try {
            for (const [column, value] of Object.entries(row)) {
              convertHiveValue(value, targetTypes.get(column) ?? 'string', lineNumber, column)
            }
            pending.push(row)
          } catch (error) {
            warnings.push(errorMessage(error))
            skipped += 1
          }
        }

        if (pending.length >= request.batchSize) {
          await insertRows(
            session,
            request.table,
            pending,
            targetTypes
          )
          rows += pending.length
          pending = []
          lastProgressLine = lineNumber
          onProgress?.(rows, lineNumber)
        }
      }

      if (pending.length > 0) {
        await insertRows(session, request.table, pending, targetTypes)
        rows += pending.length
        pending = []
        lastProgressLine = lineNumber
      }
      if (lineNumber > lastProgressLine) {
        lastProgressLine = lineNumber
        onProgress?.(rows, lineNumber)
      }
    })

    return {
      rows,
      skipped,
      ...(warnings.length > 0 ? { warnings } : {}),
      durationMs: performance.now() - startedAt,
      table: request.table
    }
  }

  private async withSession<T>(
    connection: ConnectionConfig,
    operation: (session: HiveSessionLike) => Promise<T>
  ): Promise<T> {
    const session = await this.sessionFactory(connection)
    try {
      return await operation(session)
    } finally {
      await session.close().catch(() => undefined)
    }
  }
}

async function openDriverSession(connection: ConnectionConfig): Promise<HiveSessionLike> {
  const client = new HiveClient(thrift.TCLIService, thrift.TCLIService_types)
  const errors: Error[] = []
  client.on('error', (error: Error) => errors.push(error))

  const transportMode = connection.transportMode ?? 'binary'
  const connectionProvider =
    transportMode === 'http'
      ? new hiveConnections.HttpConnection()
      : new hiveConnections.TcpConnection()
  const auth = buildHiveAuth(connection, transportMode)
  const options =
    transportMode === 'http'
      ? {
          host: connection.host,
          port: connection.port,
          options: { path: normalizeHttpPath(connection.httpPath) }
        }
      : { host: connection.host, port: connection.port }

  await client.connect(options, connectionProvider, auth)
  const session = await client.openSession({
    client_protocol: thrift.TCLIService_types.TProtocolVersion.HIVE_CLI_SERVICE_PROTOCOL_V10
  })
  const utils = new HiveUtils(thrift.TCLIService_types)

  return {
    async query(statement: string): Promise<HiveQueryResult> {
      if (errors.length > 0) {
        throw errors[0]
      }
      const operation = await session.executeStatement(statement, { runAsync: true })
      try {
        await utils.waitUntilReady(operation, false, () => undefined)
        await utils.fetchAll(operation)
        const rawRows = utils.getResult(operation).getValue() as unknown
        const rows = Array.isArray(rawRows)
          ? rawRows.filter(isRecord)
          : []
        const schemaColumns = operation.getSchema()?.columns ?? []
        const columns = [...schemaColumns]
          .sort((left, right) => left.position - right.position)
          .map((column) => column.columnName.split('.').pop() ?? column.columnName)
        return { columns, rows }
      } finally {
        await operation.close().catch(() => undefined)
      }
    },
    async close(): Promise<void> {
      await session.close().catch(() => undefined)
      client.close()
    }
  }
}

function buildHiveAuth(
  connection: ConnectionConfig,
  transportMode: 'binary' | 'http'
): InstanceType<
  | typeof hiveAuth.PlainHttpAuthentication
  | typeof hiveAuth.PlainTcpAuthentication
  | typeof hiveAuth.KerberosHttpAuthentication
  | typeof hiveAuth.KerberosTcpAuthentication
> {
  const credentials = {
    username: connection.username ?? '',
    password: connection.password ?? ''
  }
  if ((connection.auth ?? 'NONE') === 'KERBEROS') {
    let kerberos: object
    try {
      kerberos = createRequire(import.meta.url)('kerberos') as object
    } catch {
      throw new Error('Hive KERBEROS 认证需要安装可选依赖 kerberos')
    }
    const authProcess = new hiveAuth.helpers.MongoKerberosAuthProcess(
      { fqdn: connection.host, service: 'hive' },
      kerberos as never
    )
    return transportMode === 'http'
      ? new hiveAuth.KerberosHttpAuthentication(credentials, authProcess)
      : new hiveAuth.KerberosTcpAuthentication(credentials, authProcess)
  }
  return transportMode === 'http'
    ? new hiveAuth.PlainHttpAuthentication(credentials)
    : new hiveAuth.PlainTcpAuthentication(credentials)
}

function normalizeHttpPath(value: string | undefined): string {
  const path = (value ?? '/cliservice').trim()
  if (path.length === 0) {
    return '/cliservice'
  }
  return path.startsWith('/') ? path : `/${path}`
}

function resolveDatabase(connection: ConnectionConfig, database?: string): string {
  const value = (database ?? connection.database ?? '').trim()
  if (value.length === 0) {
    throw new Error('请先选择 Hive 数据库')
  }
  return value
}

function qualifiedTable(table: HiveTable): string {
  return `${quoteIdentifier(table.database)}.${quoteIdentifier(table.name)}`
}

function quoteIdentifier(value: string): string {
  return `\`${value.replace(/`/g, '``')}\``
}

function firstValue(row: Record<string, unknown>): unknown {
  return Object.values(row)[0]
}

function rowValue(row: Record<string, unknown>, column: string): unknown {
  if (column in row) {
    return row[column]
  }
  const entry = Object.entries(row).find(([key]) => key.split('.').pop() === column)
  return entry?.[1]
}

function normalizeHiveValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString()
  }
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    return JSON.stringify(value)
  }
  return value
}

interface HiveTargetColumn {
  name: string
  dataType: string
}

async function describeTable(
  session: HiveSessionLike,
  table: HiveTable
): Promise<HiveTargetColumn[]> {
  const result = await session.query(`DESCRIBE ${qualifiedTable(table)}`)
  const columns: HiveTargetColumn[] = []
  for (const row of result.rows) {
    const name = String(row.col_name ?? firstValue(row) ?? '').trim()
    const dataType = String(row.data_type ?? Object.values(row)[1] ?? '').trim()
    if (name.length === 0 || name.startsWith('#')) {
      continue
    }
    columns.push({ name, dataType })
  }
  return columns
}

async function insertRows(
  session: HiveSessionLike,
  table: HiveTable,
  rows: Array<Record<string, unknown>>,
  targetTypes: Map<string, string>
): Promise<void> {
  if (rows.length === 0) {
    return
  }
  const columns: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (!seen.has(column)) {
        seen.add(column)
        columns.push(column)
      }
    }
  }
  const valueGroups = rows.map((row) => {
    const values = columns.map((column) =>
      convertHiveValue(row[column], targetTypes.get(column) ?? 'string')
    )
    return `(${values.join(', ')})`
  })
  const statement =
    `INSERT INTO ${qualifiedTable(table)} ` +
    `(${columns.map(quoteIdentifier).join(', ')}) VALUES ${valueGroups.join(', ')}`
  await session.query(statement)
}

function convertHiveValue(
  value: unknown,
  dataType: string,
  lineNumber?: number,
  column?: string
): string {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  const type = dataType.toLowerCase()
  try {
    if (
      type.startsWith('array<') ||
      type.startsWith('map<') ||
      type.startsWith('struct<') ||
      type.startsWith('uniontype<')
    ) {
      return quoteSqlString(typeof value === 'string' ? value : JSON.stringify(value))
    }
    if (
      type.startsWith('tinyint') ||
      type.startsWith('smallint') ||
      type.startsWith('int') ||
      type.startsWith('bigint')
    ) {
      const number = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(number) || !Number.isInteger(number)) {
        throw new Error('不是有效整数')
      }
      return String(number)
    }
    if (
      type.startsWith('float') ||
      type.startsWith('double') ||
      type.startsWith('decimal')
    ) {
      const number = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(number)) {
        throw new Error('不是有效数值')
      }
      return String(number)
    }
    if (type.startsWith('boolean')) {
      if (typeof value === 'boolean') {
        return value ? 'true' : 'false'
      }
      if (value === 0 || value === 1) {
        return value === 1 ? 'true' : 'false'
      }
      if (typeof value === 'string' && /^(true|false)$/i.test(value)) {
        return value.toLowerCase()
      }
      throw new Error('不是有效布尔值')
    }
    if (type.startsWith('date') || type.startsWith('timestamp')) {
      const text = value instanceof Date ? value.toISOString() : String(value)
      if (text.trim().length === 0) {
        throw new Error('不是有效日期')
      }
      return quoteSqlString(text)
    }
    if (type.startsWith('binary')) {
      const buffer = Buffer.isBuffer(value)
        ? value
        : typeof value === 'string' && /^[0-9a-f]+$/i.test(value)
          ? Buffer.from(value, 'hex')
          : Buffer.from(String(value), 'utf8')
      return `X'${buffer.toString('hex')}'`
    }
    return quoteSqlString(
      typeof value === 'string' ? value : Array.isArray(value) || typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
    )
  } catch (error) {
    const location =
      lineNumber !== undefined
        ? `第 ${lineNumber} 行${column ? `列 ${column}` : ''}`
        : column
          ? `列 ${column}`
          : '值'
    throw new Error(`${location}转换为 Hive ${dataType} 失败：${errorMessage(error)}`)
  }
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/\u0000/g, '').replace(/'/g, "''")}'`
}

function stringifyEnvelope(
  table: HiveTable,
  columns: string[],
  rows: unknown[][]
): string {
  return JSON.stringify({ table, columns, rows }, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function hiveErrorMessage(
  error: unknown,
  connection?: ConnectionConfig
): string {
  const record = error as {
    name?: unknown
    code?: unknown
    message?: unknown
    statusCode?: unknown
  }
  const name = typeof record?.name === 'string' ? record.name : ''
  const code = typeof record?.code === 'string' ? record.code : ''
  const base =
    typeof record?.message === 'string' && record.message.length > 0
      ? record.message
      : 'Hive 操作失败'
  const mode = connection?.transportMode === 'http' ? 'HTTP' : 'Thrift'

  if (
    name.includes('Authentication') ||
    /auth|credential|unauthorized|forbidden|401|403/i.test(`${code} ${base}`)
  ) {
    return `${base} [${mode} Authentication failed]`
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(base)) {
    const target = connection ? `${connection.host}:${connection.port}` : ''
    return `${base} [${mode} Connection refused${target ? `: ${target}` : ''}]`
  }
  if (code === 'ETIMEDOUT' || /timeout|timed out/i.test(base)) {
    return `${base} [${mode} Connection timeout]`
  }
  return `${base} [${mode}]`
}

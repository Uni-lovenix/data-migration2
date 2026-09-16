import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
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
  HiveMigrationResult,
  HiveTable
} from '../shared/types'
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

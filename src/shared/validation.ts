import {
  CONNECTION_TYPES,
  type ConnectionInput,
  type ConnectionType,
  type CreateMigrationTaskInput,
  type ElasticsearchConflictAction,
  type ElasticsearchExportRequest,
  type ElasticsearchImportRequest,
  type ElasticsearchMappingConfig,
  type ElasticsearchReadStrategy,
  type HiveAuth,
  type HiveCountRowsRequest,
  type HiveExportRequest,
  type HiveImportRequest,
  type HiveTable,
  type HiveTransportMode,
  HIVE_AUTH_MODES,
  HIVE_TRANSPORT_MODES,
  type MigrationTaskPayload,
  type MigrationTaskType,
  MIGRATION_TASK_TYPES,
  type MySQLBatchExportRequest,
  type MySQLConflictAction,
  type MySQLCountRowsRequest,
  type MySQLExportRequest,
  type MySQLImportRequest,
  type MySQLTableRef,
  type PostgresConflictAction,
  type PostgresCountRowsRequest,
  type PostgresExportRequest,
  type PostgresBatchExportRequest,
  type PostgresImportRequest,
  type PostgresTableRef,
  type SQLiteBatchExportRequest,
  type SQLiteCountRowsRequest,
  type SQLiteExportRequest,
  type SQLiteTableRef
} from './types'

export type ValidationResult =
  | { ok: true; value: ConnectionInput }
  | { ok: false; errors: string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isConnectionType(value: unknown): value is ConnectionType {
  return typeof value === 'string' && CONNECTION_TYPES.includes(value as ConnectionType)
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined
  }
  return value.trim()
}

function isAbsoluteFilePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value)
}

export function validateConnectionInput(input: unknown): ValidationResult {
  const errors: string[] = []

  if (!isRecord(input)) {
    return { ok: false, errors: ['连接配置必须是对象'] }
  }

  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name.length === 0 || name.length > 80) {
    errors.push('名称不能为空且不能超过 80 个字符')
  }

  if (!isConnectionType(input.type)) {
    errors.push('连接类型必须是 postgresql、elasticsearch、mysql、sqlite、hive 或 neo4j')
  }

  if (input.type === 'sqlite') {
    const filePath = optionalString(input.filePath)
    if (!filePath || !isAbsoluteFilePath(filePath)) {
      errors.push('SQLite 数据库路径必须是非空绝对路径')
    } else if (filePath.length > 4096) {
      errors.push('SQLite 数据库路径不能超过 4096 个字符')
    }

    if (errors.length > 0 || !filePath) {
      return { ok: false, errors }
    }

    return {
      ok: true,
      value: {
        name,
        type: 'sqlite',
        host: filePath,
        port: 0,
        filePath,
        ssl: false
      }
    }
  }

  const host = typeof input.host === 'string' ? input.host.trim() : ''
  if (host.length === 0 || host.length > 255) {
    errors.push('主机地址不能为空且不能超过 255 个字符')
  }

  const port = typeof input.port === 'number' ? input.port : Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('端口必须是 1 到 65535 之间的整数')
  }

  const ssl = typeof input.ssl === 'boolean' ? input.ssl : input.ssl === 'true'

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  const value: ConnectionInput = {
    name,
    type: input.type as ConnectionType,
    host,
    port,
    ssl
  }

  if (value.type === 'hive') {
    const auth = input.auth
    if (auth !== undefined && !isHiveAuth(auth)) {
      errors.push('Hive auth 必须是 NONE、LDAP、KERBEROS 或 CUSTOM')
    }
    const transportMode = input.transportMode
    if (transportMode !== undefined && !isHiveTransportMode(transportMode)) {
      errors.push('Hive transportMode 必须是 binary 或 http')
    }
    if (errors.length > 0) {
      return { ok: false, errors }
    }
    value.auth = isHiveAuth(auth) ? auth : 'NONE'
    value.transportMode = isHiveTransportMode(transportMode) ? transportMode : 'binary'
    const httpPath = optionalString(input.httpPath)
    if (httpPath !== undefined) {
      value.httpPath = httpPath.startsWith('/') ? httpPath : `/${httpPath}`
    }
  }

  const username = optionalString(input.username)
  const password = optionalString(input.password)
  const database = optionalString(input.database)
  const defaultIndex = optionalString(input.defaultIndex)

  if (username !== undefined) {
    value.username = username
  }
  if (password !== undefined) {
    value.password = password
  }
  if (database !== undefined) {
    value.database = database
  }
  if (defaultIndex !== undefined) {
    value.defaultIndex = defaultIndex
  }

  // MySQL-only TLS material. Ignored for other engines so the payload stays clean.
  if (value.type === 'mysql') {
    const sslCa = optionalString(input.sslCa)
    const sslCert = optionalString(input.sslCert)
    if (sslCa !== undefined) {
      value.sslCa = sslCa
    }
    if (sslCert !== undefined) {
      value.sslCert = sslCert
    }
  }

  if (value.type === 'neo4j') {
    const uri = optionalString(input.uri)
    if (uri !== undefined) {
      value.uri = uri
    }
  }

  return { ok: true, value }
}

export function connectionTypeLabel(type: ConnectionType): string {
  if (type === 'postgresql') {
    return 'PostgreSQL'
  }
  if (type === 'elasticsearch') {
    return 'Elasticsearch'
  }
  if (type === 'mysql') {
    return 'MySQL'
  }
  if (type === 'sqlite') {
    return 'SQLite'
  }
  if (type === 'hive') {
    return 'Hive'
  }
  return 'Neo4j'
}

export function defaultPortForType(type: ConnectionType): number {
  if (type === 'postgresql') {
    return 5432
  }
  if (type === 'elasticsearch') {
    return 9200
  }
  if (type === 'mysql') {
    return 3306
  }
  if (type === 'sqlite') {
    return 0
  }
  if (type === 'hive') {
    return 10000
  }
  return 7687
}

function isHiveAuth(value: unknown): value is HiveAuth {
  return typeof value === 'string' && (HIVE_AUTH_MODES as readonly string[]).includes(value)
}

function isHiveTransportMode(value: unknown): value is HiveTransportMode {
  return (
    typeof value === 'string' &&
    (HIVE_TRANSPORT_MODES as readonly string[]).includes(value)
  )
}

export type PostgresExportValidationResult =
  | { ok: true; value: PostgresExportRequest }
  | { ok: false; errors: string[] }

export type PostgresBatchExportValidationResult =
  | { ok: true; value: PostgresBatchExportRequest }
  | { ok: false; errors: string[] }

export type PostgresImportValidationResult =
  | { ok: true; value: PostgresImportRequest }
  | { ok: false; errors: string[] }

export type PostgresCountRowsValidationResult =
  | { ok: true; value: PostgresCountRowsRequest }
  | { ok: false; errors: string[] }

function validateTableRef(value: unknown): { value?: PostgresTableRef; errors: string[] } {
  const errors: string[] = []
  if (!isRecord(value)) {
    return { errors: ['表信息必须是对象'] }
  }

  const schema = typeof value.schema === 'string' ? value.schema.trim() : ''
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (schema.length === 0 || schema.length > 255) {
    errors.push('表 schema 不能为空且不能超过 255 个字符')
  }
  if (name.length === 0 || name.length > 255) {
    errors.push('表名不能为空且不能超过 255 个字符')
  }

  if (errors.length > 0) {
    return { errors }
  }
  return { value: { schema, name }, errors }
}

function validateConnectionId(value: unknown): { value?: string; errors: string[] } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { errors: ['连接 ID 不能为空'] }
  }
  return { value: value.trim(), errors: [] }
}

function validateFilePath(value: unknown, label: string): { value?: string; errors: string[] } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { errors: [`${label}不能为空`] }
  }
  return { value: value.trim(), errors: [] }
}

function validateBatchSize(value: unknown): { value?: number; errors: string[] } {
  const batchSize = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000) {
    return { errors: ['批量大小必须是 1 到 10000 之间的整数'] }
  }
  return { value: batchSize, errors: [] }
}

function optionalDatabase(value: unknown): { value?: string; errors: string[] } {
  if (value === undefined || value === null) {
    return { errors: [] }
  }
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 255) {
    return { errors: ['数据库名不能为空且不能超过 255 个字符'] }
  }
  return { value: value.trim(), errors: [] }
}

function isConflictAction(value: unknown): value is PostgresConflictAction {
  return value === 'error' || value === 'skip'
}

function isMySQLConflictAction(value: unknown): value is MySQLConflictAction {
  return value === 'error' || value === 'skip' || value === 'update'
}

export function validatePostgresExportRequest(
  input: unknown
): PostgresExportValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['导出请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const table = validateTableRef(input.table)
  const outputFile = validateFilePath(input.outputFile, '导出文件路径')
  const batchSize = validateBatchSize(input.batchSize)
  const database = optionalDatabase(input.database)
  const where = validateWhereClause(input.where)
  errors.push(
    ...connectionId.errors,
    ...table.errors,
    ...outputFile.errors,
    ...batchSize.errors,
    ...database.errors,
    ...where.errors
  )

  if (errors.length > 0 || !connectionId.value || !table.value || !outputFile.value || !batchSize.value) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      table: table.value,
      outputFile: outputFile.value,
      batchSize: batchSize.value,
      ...(database.value !== undefined ? { database: database.value } : {}),
      ...(where.value !== undefined ? { where: where.value } : {})
    }
  }
}

export function validatePostgresBatchExportRequest(
  input: unknown
): PostgresBatchExportValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['导出请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const outputDirectory = validateFilePath(input.outputDirectory, '导出目录')
  const batchSize = validateBatchSize(input.batchSize)
  const database = optionalDatabase(input.database)
  const where = validateWhereClause(input.where)
  errors.push(
    ...connectionId.errors,
    ...outputDirectory.errors,
    ...batchSize.errors,
    ...database.errors,
    ...where.errors
  )

  const tables: PostgresTableRef[] = []
  if (!Array.isArray(input.tables) || input.tables.length === 0) {
    errors.push('至少选择一张表')
  } else {
    for (const table of input.tables) {
      const result = validateTableRef(table)
      errors.push(...result.errors)
      if (result.value) {
        tables.push(result.value)
      }
    }
  }

  if (
    errors.length > 0 ||
    !connectionId.value ||
    !outputDirectory.value ||
    !batchSize.value
  ) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      tables,
      outputDirectory: outputDirectory.value,
      batchSize: batchSize.value,
      ...(database.value !== undefined ? { database: database.value } : {}),
      ...(where.value !== undefined ? { where: where.value } : {})
    }
  }
}

export function validatePostgresImportRequest(
  input: unknown
): PostgresImportValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['导入请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const table = validateTableRef(input.table)
  const inputFile = validateFilePath(input.inputFile, '导入文件路径')
  const batchSize = validateBatchSize(input.batchSize)
  const database = optionalDatabase(input.database)
  errors.push(
    ...connectionId.errors,
    ...table.errors,
    ...inputFile.errors,
    ...batchSize.errors,
    ...database.errors
  )
  if (input.onConflict !== undefined && !isConflictAction(input.onConflict)) {
    errors.push('冲突处理必须是 error 或 skip')
  }

  if (errors.length > 0 || !connectionId.value || !table.value || !inputFile.value || !batchSize.value) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      table: table.value,
      inputFile: inputFile.value,
      batchSize: batchSize.value,
      onConflict: input.onConflict === 'error' ? 'error' : 'skip',
      ...(database.value !== undefined ? { database: database.value } : {})
    }
  }
}

export function validatePostgresCountRowsRequest(
  input: unknown
): PostgresCountRowsValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['行数统计请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const table = validateTableRef(input.table)
  const database = optionalDatabase(input.database)
  errors.push(...connectionId.errors, ...table.errors, ...database.errors)

  if (errors.length > 0 || !connectionId.value || !table.value) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      table: table.value,
      ...(database.value !== undefined ? { database: database.value } : {})
    }
  }
}

// =====================================================
// MySQL 导出（与 Postgres 校验器一一对应）
// =====================================================

export type MySQLExportValidationResult =
  | { ok: true; value: MySQLExportRequest }
  | { ok: false; errors: string[] }

export type MySQLBatchExportValidationResult =
  | { ok: true; value: MySQLBatchExportRequest }
  | { ok: false; errors: string[] }

export type MySQLCountRowsValidationResult =
  | { ok: true; value: MySQLCountRowsRequest }
  | { ok: false; errors: string[] }

export type MySQLImportValidationResult =
  | { ok: true; value: MySQLImportRequest }
  | { ok: false; errors: string[] }

/** MySQL 的 table ref 与 Postgres 同构（schema 字段承载 database 名）。 */
function asMySQLTableRef(value: PostgresTableRef): MySQLTableRef {
  return { schema: value.schema, name: value.name }
}

export function validateMySQLExportRequest(
  input: unknown
): MySQLExportValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['导出请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const table = validateTableRef(input.table)
  const outputFile = validateFilePath(input.outputFile, '导出文件路径')
  const batchSize = validateBatchSize(input.batchSize)
  const database = optionalDatabase(input.database)
  errors.push(
    ...connectionId.errors,
    ...table.errors,
    ...outputFile.errors,
    ...batchSize.errors,
    ...database.errors
  )

  if (errors.length > 0 || !connectionId.value || !table.value || !outputFile.value || !batchSize.value) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      table: asMySQLTableRef(table.value),
      outputFile: outputFile.value,
      batchSize: batchSize.value,
      ...(database.value !== undefined ? { database: database.value } : {})
    }
  }
}

export function validateMySQLBatchExportRequest(
  input: unknown
): MySQLBatchExportValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['导出请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const outputDirectory = validateFilePath(input.outputDirectory, '导出目录')
  const batchSize = validateBatchSize(input.batchSize)
  const database = optionalDatabase(input.database)
  errors.push(
    ...connectionId.errors,
    ...outputDirectory.errors,
    ...batchSize.errors,
    ...database.errors
  )

  const tables: MySQLTableRef[] = []
  if (!Array.isArray(input.tables) || input.tables.length === 0) {
    errors.push('至少选择一张表')
  } else {
    for (const table of input.tables) {
      const result = validateTableRef(table)
      errors.push(...result.errors)
      if (result.value) {
        tables.push(asMySQLTableRef(result.value))
      }
    }
  }

  if (errors.length > 0 || !connectionId.value || !outputDirectory.value || !batchSize.value) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      tables,
      outputDirectory: outputDirectory.value,
      batchSize: batchSize.value,
      ...(database.value !== undefined ? { database: database.value } : {})
    }
  }
}

export function validateMySQLImportRequest(
  input: unknown
): MySQLImportValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['导入请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const table = validateTableRef(input.table)
  const inputFile = validateFilePath(input.inputFile, '导入文件路径')
  const batchSize = validateBatchSize(input.batchSize)
  const database = optionalDatabase(input.database)
  errors.push(
    ...connectionId.errors,
    ...table.errors,
    ...inputFile.errors,
    ...batchSize.errors,
    ...database.errors
  )
  if (input.onConflict !== undefined && !isMySQLConflictAction(input.onConflict)) {
    errors.push('冲突处理必须是 error、skip 或 update')
  }

  if (
    errors.length > 0 ||
    !connectionId.value ||
    !table.value ||
    !inputFile.value ||
    !batchSize.value
  ) {
    return { ok: false, errors }
  }

  const onConflict: MySQLConflictAction =
    input.onConflict === 'skip'
      ? 'skip'
      : input.onConflict === 'update'
        ? 'update'
        : 'error'

  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      table: asMySQLTableRef(table.value),
      inputFile: inputFile.value,
      batchSize: batchSize.value,
      onConflict,
      ...(database.value !== undefined ? { database: database.value } : {})
    }
  }
}

export function validateMySQLCountRowsRequest(
  input: unknown
): MySQLCountRowsValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['行数统计请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const table = validateTableRef(input.table)
  const database = optionalDatabase(input.database)
  errors.push(...connectionId.errors, ...table.errors, ...database.errors)

  if (errors.length > 0 || !connectionId.value || !table.value) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      table: asMySQLTableRef(table.value),
      ...(database.value !== undefined ? { database: database.value } : {})
    }
  }
}

export type SQLiteExportValidationResult =
  | { ok: true; value: SQLiteExportRequest }
  | { ok: false; errors: string[] }

export type SQLiteBatchExportValidationResult =
  | { ok: true; value: SQLiteBatchExportRequest }
  | { ok: false; errors: string[] }

export type SQLiteCountRowsValidationResult =
  | { ok: true; value: SQLiteCountRowsRequest }
  | { ok: false; errors: string[] }

function asSQLiteTableRef(value: PostgresTableRef): SQLiteTableRef {
  return { schema: value.schema, name: value.name }
}

export function validateSQLiteExportRequest(
  input: unknown
): SQLiteExportValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['导出请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const table = validateTableRef(input.table)
  const outputFile = validateFilePath(input.outputFile, '导出文件路径')
  const batchSize = validateBatchSize(input.batchSize)
  errors.push(
    ...connectionId.errors,
    ...table.errors,
    ...outputFile.errors,
    ...batchSize.errors
  )

  if (
    errors.length > 0 ||
    !connectionId.value ||
    !table.value ||
    !outputFile.value ||
    !batchSize.value
  ) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      table: asSQLiteTableRef(table.value),
      outputFile: outputFile.value,
      batchSize: batchSize.value
    }
  }
}

export function validateSQLiteBatchExportRequest(
  input: unknown
): SQLiteBatchExportValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['导出请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const outputDirectory = validateFilePath(input.outputDirectory, '导出目录')
  const batchSize = validateBatchSize(input.batchSize)
  errors.push(...connectionId.errors, ...outputDirectory.errors, ...batchSize.errors)

  const tables: SQLiteTableRef[] = []
  if (!Array.isArray(input.tables) || input.tables.length === 0) {
    errors.push('至少选择一张表')
  } else {
    for (const table of input.tables) {
      const result = validateTableRef(table)
      errors.push(...result.errors)
      if (result.value) {
        tables.push(asSQLiteTableRef(result.value))
      }
    }
  }

  if (errors.length > 0 || !connectionId.value || !outputDirectory.value || !batchSize.value) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      tables,
      outputDirectory: outputDirectory.value,
      batchSize: batchSize.value
    }
  }
}

export function validateSQLiteCountRowsRequest(
  input: unknown
): SQLiteCountRowsValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['行数统计请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const table = validateTableRef(input.table)
  errors.push(...connectionId.errors, ...table.errors)

  if (errors.length > 0 || !connectionId.value || !table.value) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      table: asSQLiteTableRef(table.value)
    }
  }
}

export type HiveExportValidationResult =
  | { ok: true; value: HiveExportRequest }
  | { ok: false; errors: string[] }

export type HiveCountRowsValidationResult =
  | { ok: true; value: HiveCountRowsRequest }
  | { ok: false; errors: string[] }

export type HiveImportValidationResult =
  | { ok: true; value: HiveImportRequest }
  | { ok: false; errors: string[] }

function validateHiveTable(value: unknown): { value?: HiveTable; errors: string[] } {
  if (!isRecord(value)) {
    return { errors: ['Hive 表信息必须是对象'] }
  }
  const database = typeof value.database === 'string' ? value.database.trim() : ''
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const errors: string[] = []
  if (database.length === 0 || database.length > 255) {
    errors.push('Hive 数据库名不能为空且不能超过 255 个字符')
  }
  if (name.length === 0 || name.length > 255) {
    errors.push('Hive 表名不能为空且不能超过 255 个字符')
  }
  return errors.length > 0 ? { errors } : { value: { database, name }, errors }
}

export function validateHiveExportRequest(
  input: unknown
): HiveExportValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['导出请求必须是对象'] }
  }
  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const table = validateHiveTable(input.table)
  const outputFile = validateFilePath(input.outputFile, '导出文件路径')
  const batchSize = validateBatchSize(input.batchSize)
  errors.push(
    ...connectionId.errors,
    ...table.errors,
    ...outputFile.errors,
    ...batchSize.errors
  )

  if (
    errors.length > 0 ||
    !connectionId.value ||
    !table.value ||
    !outputFile.value ||
    !batchSize.value
  ) {
    return { ok: false, errors }
  }
  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      table: table.value,
      outputFile: outputFile.value,
      batchSize: batchSize.value
    }
  }
}

export function validateHiveCountRowsRequest(
  input: unknown
): HiveCountRowsValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['行数统计请求必须是对象'] }
  }
  const connectionId = validateConnectionId(input.connectionId)
  const table = validateHiveTable(input.table)
  const errors = [...connectionId.errors, ...table.errors]
  if (errors.length > 0 || !connectionId.value || !table.value) {
    return { ok: false, errors }
  }
  return {
    ok: true,
    value: { connectionId: connectionId.value, table: table.value }
  }
}

export function validateHiveImportRequest(
  input: unknown
): HiveImportValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['导入请求必须是对象'] }
  }
  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const table = validateHiveTable(input.table)
  const inputFile = validateFilePath(input.inputFile, '导入文件路径')
  const batchSize = validateBatchSize(input.batchSize)
  errors.push(
    ...connectionId.errors,
    ...table.errors,
    ...inputFile.errors,
    ...batchSize.errors
  )
  if (
    errors.length > 0 ||
    !connectionId.value ||
    !table.value ||
    !inputFile.value ||
    !batchSize.value
  ) {
    return { ok: false, errors }
  }
  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      table: table.value,
      inputFile: inputFile.value,
      batchSize: batchSize.value
    }
  }
}

export type ElasticsearchExportValidationResult =
  | { ok: true; value: ElasticsearchExportRequest }
  | { ok: false; errors: string[] }

export type ElasticsearchImportValidationResult =
  | { ok: true; value: ElasticsearchImportRequest }
  | { ok: false; errors: string[] }

function validateIndex(value: unknown): { value?: string; errors: string[] } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { errors: ['索引不能为空'] }
  }
  const index = value.trim()
  if (index.length > 255) {
    return { errors: ['索引名不能超过 255 个字符'] }
  }
  return { value: index, errors: [] }
}

function isElasticsearchStrategy(value: unknown): value is ElasticsearchReadStrategy {
  return value === 'scroll' || value === 'search_after'
}

function isElasticsearchConflictAction(value: unknown): value is ElasticsearchConflictAction {
  return value === 'overwrite' || value === 'skip'
}

function validateQueryJson(value: unknown): { value?: string; errors: string[] } {
  if (value === undefined || value === null) {
    return { errors: [] }
  }
  if (typeof value !== 'string') {
    return { errors: ['查询必须是字符串'] }
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return { errors: [] }
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { errors: ['查询 JSON 顶层必须是对象'] }
    }
    return { value: trimmed, errors: [] }
  } catch (cause) {
    return {
      errors: [`查询不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}`]
    }
  }
}

const WHERE_CLAUSE_MAX_LENGTH = 4000

function validateWhereClause(value: unknown): { value?: string; errors: string[] } {
  if (value === undefined || value === null) {
    return { errors: [] }
  }
  if (typeof value !== 'string') {
    return { errors: ['SQL 条件必须是字符串'] }
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return { errors: [] }
  }
  if (trimmed.includes(';')) {
    return { errors: ['SQL 条件不能包含分号 (;)'] }
  }
  if (trimmed.includes('--')) {
    return { errors: ['SQL 条件不能包含行注释 (--)'] }
  }
  if (trimmed.length > WHERE_CLAUSE_MAX_LENGTH) {
    return { errors: [`SQL 条件长度不能超过 ${WHERE_CLAUSE_MAX_LENGTH} 个字符`] }
  }
  return { value: trimmed, errors: [] }
}

function validateMappingConfig(
  value: unknown
): { value?: ElasticsearchMappingConfig; errors: string[] } {
  if (value === undefined || value === null) {
    return { errors: [] }
  }
  if (!isRecord(value)) {
    return { errors: ['mapping 必须是对象'] }
  }
  if (value.source !== 'sidecar' && value.source !== 'inline') {
    return { errors: ['mapping.source 必须是 sidecar 或 inline'] }
  }
  const cfg: ElasticsearchMappingConfig = { source: value.source }
  if (typeof value.inlineJson === 'string' && value.inlineJson.trim().length > 0) {
    const trimmed = value.inlineJson.trim()
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { errors: ['mapping.inlineJson 顶层必须是对象'] }
      }
    } catch (cause) {
      return {
        errors: [
          `mapping.inlineJson 不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}`
        ]
      }
    }
    cfg.inlineJson = trimmed
  }
  if (typeof value.sidecarPath === 'string' && value.sidecarPath.trim().length > 0) {
    cfg.sidecarPath = value.sidecarPath.trim()
  }
  if (cfg.source === 'inline' && !cfg.inlineJson) {
    return { errors: ['mapping.source 为 inline 时必须提供 inlineJson'] }
  }
  return { value: cfg, errors: [] }
}

export function validateElasticsearchExportRequest(
  input: unknown
): ElasticsearchExportValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['导出请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const index = validateIndex(input.index)
  const outputFile = validateFilePath(input.outputFile, '导出文件路径')
  const batchSize = validateBatchSize(input.batchSize)
  const query = validateQueryJson(input.query)
  errors.push(
    ...connectionId.errors,
    ...index.errors,
    ...outputFile.errors,
    ...batchSize.errors,
    ...query.errors
  )
  if (input.strategy !== undefined && !isElasticsearchStrategy(input.strategy)) {
    errors.push('读取方式必须是 scroll 或 search_after')
  }

  if (
    errors.length > 0 ||
    !connectionId.value ||
    !index.value ||
    !outputFile.value ||
    !batchSize.value
  ) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      index: index.value,
      outputFile: outputFile.value,
      batchSize: batchSize.value,
      strategy: input.strategy === 'search_after' ? 'search_after' : 'scroll',
      ...(query.value !== undefined ? { query: query.value } : {}),
      ...(input.exportMapping === false ? { exportMapping: false } : { exportMapping: true })
    }
  }
}

export function validateElasticsearchImportRequest(
  input: unknown
): ElasticsearchImportValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['导入请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const index = validateIndex(input.index)
  const inputFile = validateFilePath(input.inputFile, '导入文件路径')
  const batchSize = validateBatchSize(input.batchSize)
  const mapping = validateMappingConfig(input.mapping)
  errors.push(
    ...connectionId.errors,
    ...index.errors,
    ...inputFile.errors,
    ...batchSize.errors,
    ...mapping.errors
  )
  if (input.onConflict !== undefined && !isElasticsearchConflictAction(input.onConflict)) {
    errors.push('冲突处理必须是 overwrite 或 skip')
  }

  if (
    errors.length > 0 ||
    !connectionId.value ||
    !index.value ||
    !inputFile.value ||
    !batchSize.value
  ) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      index: index.value,
      inputFile: inputFile.value,
      batchSize: batchSize.value,
      onConflict: input.onConflict === 'overwrite' ? 'overwrite' : 'skip',
      ...(input.createIndex === false ? { createIndex: false } : { createIndex: true }),
      ...(mapping.value !== undefined ? { mapping: mapping.value } : {})
    }
  }
}

export type CreateMigrationTaskValidationResult =
  | { ok: true; value: CreateMigrationTaskInput }
  | { ok: false; errors: string[] }

function isMigrationTaskType(value: unknown): value is MigrationTaskType {
  return (
    typeof value === 'string' &&
    MIGRATION_TASK_TYPES.includes(value as MigrationTaskType)
  )
}

export function validateCreateMigrationTaskInput(
  input: unknown
): CreateMigrationTaskValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['任务输入必须是对象'] }
  }
  if (!isMigrationTaskType(input.type)) {
    return { ok: false, errors: ['任务类型无效'] }
  }

  const type = input.type
  const payloadResult = validateTaskPayload(type, input.payload)
  if (!payloadResult.ok) {
    return { ok: false, errors: payloadResult.errors }
  }

  return {
    ok: true,
    value: {
      type,
      payload: payloadResult.value
    }
  }
}

function validateTaskPayload(
  type: MigrationTaskType,
  payload: unknown
):
  | { ok: true; value: MigrationTaskPayload }
  | { ok: false; errors: string[] } {
  if (type === 'postgres-export') {
    return validatePostgresExportRequest(payload)
  }
  if (type === 'postgres-export-batch') {
    return validatePostgresBatchExportRequest(payload)
  }
  if (type === 'postgres-import') {
    return validatePostgresImportRequest(payload)
  }
  if (type === 'elasticsearch-export') {
    return validateElasticsearchExportRequest(payload)
  }
  if (type === 'elasticsearch-import') {
    return validateElasticsearchImportRequest(payload)
  }
  if (type === 'mysql-export') {
    return validateMySQLExportRequest(payload)
  }
  if (type === 'mysql-import') {
    return validateMySQLImportRequest(payload)
  }
  if (type === 'sqlite-export') {
    return validateSQLiteExportRequest(payload)
  }
  if (type === 'sqlite-export-batch') {
    return validateSQLiteBatchExportRequest(payload)
  }
  if (type === 'hive-export') {
    return validateHiveExportRequest(payload)
  }
  if (type === 'hive-import') {
    return validateHiveImportRequest(payload)
  }
  return validateMySQLBatchExportRequest(payload)
}

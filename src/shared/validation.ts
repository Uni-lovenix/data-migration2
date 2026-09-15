import {
  type AccessBatchExportRequest,
  type AccessCountRowsRequest,
  type AccessExportRequest,
  type AccessTableRef,
  CONNECTION_TYPES,
  type ConnectionInput,
  type ConnectionType,
  type CreateMigrationTaskInput,
  type ElasticsearchConflictAction,
  type ElasticsearchExportRequest,
  type ElasticsearchImportRequest,
  type ElasticsearchMappingConfig,
  type ElasticsearchReadStrategy,
  type HiveBatchExportRequest,
  type HiveConnectionTestResult,
  type HiveCountRowsRequest,
  type HiveExportRequest,
  type MigrationTaskPayload,
  type MigrationTaskType,
  MIGRATION_TASK_TYPES,
  type MySQLBatchExportRequest,
  type MySQLCountRowsRequest,
  type MySQLExportRequest,
  type Neo4jBatchExportRequest,
  type Neo4jCountNodesRequest,
  type Neo4jCountRelationshipsRequest,
  type Neo4jExportRequest,
  type Neo4jTableKind,
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
    errors.push('连接类型必须是 postgresql、elasticsearch、mysql、sqlite、hive、neo4j 或 access')
  }

  const isSqlite = input.type === 'sqlite'
  const isHive = input.type === 'hive'
  const isAccess = input.type === 'access'

  const filePath = optionalString(input.filePath)
  if (isSqlite) {
    if (!filePath) {
      errors.push('SQLite 连接必须提供 filePath（.db / .sqlite / .sqlite3 文件绝对路径）')
    } else if (!isAbsolutePath(filePath)) {
      errors.push('SQLite filePath 必须是绝对路径')
    } else if (!hasSqliteExtension(filePath)) {
      errors.push('SQLite filePath 必须以 .db / .sqlite / .sqlite3 结尾')
    }
  } else if (isAccess) {
    if (!filePath) {
      errors.push('Access 连接必须提供 filePath（.accdb / .mdb 文件绝对路径）')
    } else if (!isAbsolutePath(filePath)) {
      errors.push('Access filePath 必须是绝对路径')
    } else if (!hasAccessExtension(filePath)) {
      errors.push('Access filePath 必须以 .accdb / .mdb 结尾')
    }
  }

  const host = typeof input.host === 'string' ? input.host.trim() : ''
  if (!isSqlite && !isAccess) {
    if (host.length === 0 || host.length > 255) {
      errors.push('主机地址不能为空且不能超过 255 个字符')
    }
  } else if (host.length > 255) {
    errors.push('主机地址不能超过 255 个字符')
  }

  const port = typeof input.port === 'number' ? input.port : Number(input.port)
  if (!isSqlite && !isAccess) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push('端口必须是 1 到 65535 之间的整数')
    }
  } else if (port !== 0 && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    errors.push('端口必须是 0 到 65535 之间的整数')
  }

  const ssl = typeof input.ssl === 'boolean' ? input.ssl : input.ssl === 'true'

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  const value: ConnectionInput = {
    name,
    type: input.type as ConnectionType,
    host: isSqlite || isAccess ? (host || '') : host,
    port: isSqlite || isAccess ? (Number.isInteger(port) ? port : 0) : (port as number),
    ssl: isSqlite ? false : ssl
  }

  const username = optionalString(input.username)
  const password = optionalString(input.password)
  const database = optionalString(input.database)
  const defaultIndex = optionalString(input.defaultIndex)

  if (!isSqlite && username !== undefined) {
    value.username = username
  }
  if (!isSqlite && password !== undefined) {
    value.password = password
  }
  if (database !== undefined && (input.type === 'postgresql' || input.type === 'mysql' || input.type === 'hive')) {
    value.database = database
  }
  if (defaultIndex !== undefined && input.type === 'elasticsearch') {
    value.defaultIndex = defaultIndex
  }
  if (isSqlite && filePath !== undefined) {
    value.filePath = filePath
  }
  if (isAccess && filePath !== undefined) {
    value.filePath = filePath
    const filePassword = optionalString(input.filePassword)
    if (filePassword !== undefined) {
      value.filePassword = filePassword
    }
  }
  if (isHive) {
    const auth = input.auth
    if (auth === 'NONE' || auth === 'LDAP' || auth === 'KERBEROS' || auth === 'CUSTOM') {
      value.auth = auth
    } else {
      errors.push('Hive 认证方式必须是 NONE / LDAP / KERBEROS / CUSTOM')
    }
    const transportMode = input.transportMode
    if (transportMode === undefined || transportMode === 'http') {
      value.transportMode = 'http'
    } else if (transportMode === 'binary') {
      value.transportMode = 'binary'
    } else {
      errors.push('Hive 传输模式必须是 http 或 binary')
    }
    const httpPath = optionalString(input.httpPath)
    if (httpPath !== undefined) {
      if (httpPath.length > 255) {
        errors.push('Hive httpPath 长度不能超过 255 个字符')
      } else {
        value.httpPath = httpPath
      }
    }
    if (username !== undefined) {
      value.username = username
    }
    if (password !== undefined) {
      value.password = password
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return { ok: true, value }
}

function isAbsolutePath(value: string): boolean {
  if (value.length === 0) return false
  // Windows: C:\path or D:/path
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true
  // Unix: /path
  return value.startsWith('/')
}

function hasSqliteExtension(value: string): boolean {
  const lower = value.toLowerCase()
  return (
    lower.endsWith('.db') ||
    lower.endsWith('.sqlite') ||
    lower.endsWith('.sqlite3')
  )
}

function hasAccessExtension(value: string): boolean {
  const lower = value.toLowerCase()
  return lower.endsWith('.accdb') || lower.endsWith('.mdb')
}

export function connectionTypeLabel(type: ConnectionType): string {
  if (type === 'postgresql') {
    return 'PostgreSQL'
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
  if (type === 'neo4j') {
    return 'Neo4j'
  }
  if (type === 'access') {
    return 'Access'
  }
  return 'Elasticsearch'
}

export function defaultPortForType(type: ConnectionType): number {
  if (type === 'postgresql') {
    return 5432
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
  if (type === 'neo4j') {
    return 7687
  }
  if (type === 'access') {
    return 0
  }
  return 9200
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
  const selectedColumns = validateSelectedColumns(input.selectedColumns)
  errors.push(
    ...connectionId.errors,
    ...table.errors,
    ...inputFile.errors,
    ...batchSize.errors,
    ...database.errors,
    ...selectedColumns.errors
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
      ...(database.value !== undefined ? { database: database.value } : {}),
      ...(selectedColumns.value !== undefined && selectedColumns.value.length > 0
        ? { selectedColumns: selectedColumns.value }
        : {})
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
// MySQL 校验器 — 与 PostgresService 同构
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
      table: table.value,
      ...(database.value !== undefined ? { database: database.value } : {})
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

/**
 * Validate the `selectedColumns` payload of an import request. Empty/missing
 * selection is treated as "import all columns". Non-empty selections must be
 * arrays of legal SQL identifiers (`[A-Za-z_][A-Za-z0-9_.]*`) and each entry
 * must be present in the supplied sourceColumns list. Missing entries are
 * reported as a single aggregated error (preserving order for diagnostic
 * readability).
 */
export function validateSelectedColumns(
  value: unknown,
  sourceColumns?: readonly string[]
): { value?: string[]; errors: string[]; missing?: string[] } {
  if (value === undefined || value === null) {
    return { errors: [] }
  }
  if (!Array.isArray(value)) {
    return { errors: ['字段选择必须是数组'] }
  }
  const trimmed: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return { errors: ['字段选择必须全部是字符串'] }
    }
    const t = entry.trim()
    if (t.length === 0) {
      return { errors: ['字段选择不能包含空字符串'] }
    }
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(t)) {
      return { errors: [`字段选择包含非法标识符：${t}（仅允许字母数字下划线 + 点号）`] }
    }
    trimmed.push(t)
  }
  if (trimmed.length === 0) {
    return { value: [], errors: [] }
  }
  if (Array.isArray(sourceColumns) && sourceColumns.length > 0) {
    const available = new Set(sourceColumns)
    const missing = trimmed.filter((c) => !available.has(c))
    if (missing.length > 0) {
      return { errors: [`字段选择中以下列在源 JSONL 中不存在：${missing.join(', ')}`], missing }
    }
  }
  // De-duplicate while preserving order.
  const dedup: string[] = []
  const seen = new Set<string>()
  for (const c of trimmed) {
    if (!seen.has(c)) {
      seen.add(c)
      dedup.push(c)
    }
  }
  return { value: dedup, errors: [] }
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
  const selectedColumns = validateSelectedColumns(input.selectedColumns)
  errors.push(
    ...connectionId.errors,
    ...index.errors,
    ...inputFile.errors,
    ...batchSize.errors,
    ...mapping.errors,
    ...selectedColumns.errors
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
      ...(mapping.value !== undefined ? { mapping: mapping.value } : {}),
      ...(selectedColumns.value !== undefined && selectedColumns.value.length > 0
        ? { selectedColumns: selectedColumns.value }
        : {})
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
  if (type === 'mysql-export-batch') {
    return validateMySQLBatchExportRequest(payload)
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
  if (type === 'hive-export-batch') {
    return validateHiveBatchExportRequest(payload)
  }
  if (type === 'neo4j-export') {
    return validateNeo4jExportRequest(payload)
  }
  if (type === 'access-export') {
    return validateAccessExportRequest(payload)
  }
  return validateNeo4jBatchExportRequest(payload)
}

// =====================================================
// SQLite 校验器 — 与 PostgresService / MySQLService 同构
// =====================================================

export type SQLiteExportValidationResult =
  | { ok: true; value: SQLiteExportRequest }
  | { ok: false; errors: string[] }

export type SQLiteBatchExportValidationResult =
  | { ok: true; value: SQLiteBatchExportRequest }
  | { ok: false; errors: string[] }

export type SQLiteCountRowsValidationResult =
  | { ok: true; value: SQLiteCountRowsRequest }
  | { ok: false; errors: string[] }

function validateSQLiteTableRef(value: unknown): { value?: SQLiteTableRef; errors: string[] } {
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

export function validateSQLiteExportRequest(input: unknown): SQLiteExportValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['导出请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const table = validateSQLiteTableRef(input.table)
  const outputFile = validateFilePath(input.outputFile, '导出文件路径')
  const batchSize = validateBatchSize(input.batchSize)
  errors.push(...connectionId.errors, ...table.errors, ...outputFile.errors, ...batchSize.errors)

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

export function validateSQLiteBatchExportRequest(input: unknown): SQLiteBatchExportValidationResult {
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
      const result = validateSQLiteTableRef(table)
      errors.push(...result.errors)
      if (result.value) {
        tables.push(result.value)
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

export function validateSQLiteCountRowsRequest(input: unknown): SQLiteCountRowsValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['行数统计请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const table = validateSQLiteTableRef(input.table)
  errors.push(...connectionId.errors, ...table.errors)

  if (errors.length > 0 || !connectionId.value || !table.value) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      table: table.value
    }
  }
}

// =====================================================
// Hive 校验器 — 与 PostgresService / MySQLService / SQLiteService 同构
// =====================================================

export type HiveExportValidationResult =
  | { ok: true; value: HiveExportRequest }
  | { ok: false; errors: string[] }

export type HiveBatchExportValidationResult =
  | { ok: true; value: HiveBatchExportRequest }
  | { ok: false; errors: string[] }

export type HiveCountRowsValidationResult =
  | { ok: true; value: HiveCountRowsRequest }
  | { ok: false; errors: string[] }

function validateHiveDatabase(value: unknown): { value?: string; errors: string[] } {
  const db = typeof value === 'string' ? value.trim() : ''
  if (db.length === 0 || db.length > 255) {
    return { errors: ['Hive 数据库名不能为空且不能超过 255 个字符'] }
  }
  return { value: db, errors: [] }
}

function validateHiveTableName(value: unknown): { value?: string; errors: string[] } {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name.length === 0 || name.length > 255) {
    return { errors: ['Hive 表名不能为空且不能超过 255 个字符'] }
  }
  return { value: name, errors: [] }
}

export function validateHiveExportRequest(input: unknown): HiveExportValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['Hive 导出请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const database = validateHiveDatabase(input.database)
  const table = validateHiveTableName(input.table)
  const outputFile = validateFilePath(input.outputFile, '导出文件路径')
  const batchSize = validateBatchSize(input.batchSize)
  const where = validateWhereClause(input.where)
  errors.push(
    ...connectionId.errors,
    ...database.errors,
    ...table.errors,
    ...outputFile.errors,
    ...batchSize.errors,
    ...where.errors
  )

  if (
    errors.length > 0 ||
    !connectionId.value ||
    !database.value ||
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
      database: database.value,
      table: table.value,
      outputFile: outputFile.value,
      batchSize: batchSize.value,
      ...(where.value !== undefined ? { where: where.value } : {})
    }
  }
}

export function validateHiveBatchExportRequest(input: unknown): HiveBatchExportValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['Hive 批量导出请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const database = validateHiveDatabase(input.database)
  const outputDirectory = validateFilePath(input.outputDirectory, '导出目录')
  const batchSize = validateBatchSize(input.batchSize)
  const where = validateWhereClause(input.where)
  errors.push(
    ...connectionId.errors,
    ...database.errors,
    ...outputDirectory.errors,
    ...batchSize.errors,
    ...where.errors
  )

  const tables: string[] = []
  if (!Array.isArray(input.tables) || input.tables.length === 0) {
    errors.push('至少选择一张表')
  } else {
    for (const t of input.tables) {
      const result = validateHiveTableName(t)
      errors.push(...result.errors)
      if (result.value) {
        tables.push(result.value)
      }
    }
  }

  if (
    errors.length > 0 ||
    !connectionId.value ||
    !database.value ||
    !outputDirectory.value ||
    !batchSize.value
  ) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      database: database.value,
      tables,
      outputDirectory: outputDirectory.value,
      batchSize: batchSize.value,
      ...(where.value !== undefined ? { where: where.value } : {})
    }
  }
}

export function validateHiveCountRowsRequest(input: unknown): HiveCountRowsValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['Hive 行数统计请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const database = validateHiveDatabase(input.database)
  const table = validateHiveTableName(input.table)
  errors.push(...connectionId.errors, ...database.errors, ...table.errors)

  if (errors.length > 0 || !connectionId.value || !database.value || !table.value) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      database: database.value,
      table: table.value
    }
  }
}

export type HiveConnectionTestValidationResult =
  | { ok: true; value: { connectionId: string } }
  | { ok: false; errors: string[] }

export function validateHiveConnectionTestRequest(input: unknown): HiveConnectionTestValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['Hive 连接测试请求必须是对象'] }
  }
  const connectionId = validateConnectionId(input.connectionId)
  if (connectionId.errors.length > 0 || !connectionId.value) {
    return { ok: false, errors: connectionId.errors }
  }
  return { ok: true, value: { connectionId: connectionId.value } }
}

// Silence unused import warning when consumers tree-shake away the runtime shape.
export type _HiveConnectionTestResultAlias = HiveConnectionTestResult

// =====================================================
// Neo4j 校验器 — 与 PG/MySQL/SQLite/Hive 校验器同构
// =====================================================

export type Neo4jExportValidationResult =
  | { ok: true; value: Neo4jExportRequest }
  | { ok: false; errors: string[] }

export type Neo4jBatchExportValidationResult =
  | { ok: true; value: Neo4jBatchExportRequest }
  | { ok: false; errors: string[] }

export type Neo4jCountNodesValidationResult =
  | { ok: true; value: Neo4jCountNodesRequest }
  | { ok: false; errors: string[] }

export type Neo4jCountRelationshipsValidationResult =
  | { ok: true; value: Neo4jCountRelationshipsRequest }
  | { ok: false; errors: string[] }

export type Neo4jConnectionTestValidationResult =
  | { ok: true; value: { connectionId: string } }
  | { ok: false; errors: string[] }

function validateNeo4jKind(value: unknown): { value?: Neo4jTableKind; errors: string[] } {
  if (value === 'node' || value === 'relationship') {
    return { value, errors: [] }
  }
  return { errors: ['kind 必须是 node 或 relationship'] }
}

function validateNeo4jLabelOrType(value: unknown, label: string): { value?: string; errors: string[] } {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name.length === 0 || name.length > 255) {
    return { errors: [`${label}不能为空且不能超过 255 个字符`] }
  }
  return { value: name, errors: [] }
}

function validateNeo4jWhereClause(value: unknown): { value?: string; errors: string[] } {
  // Cypher 片段校验：禁止分号、长度上限（与 SQL WHERE 校验同形）
  if (value === undefined || value === null) {
    return { errors: [] }
  }
  if (typeof value !== 'string') {
    return { errors: ['Cypher 条件必须是字符串'] }
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return { errors: [] }
  }
  if (trimmed.includes(';')) {
    return { errors: ['Cypher 条件不能包含分号 (;)'] }
  }
  if (trimmed.length > WHERE_CLAUSE_MAX_LENGTH) {
    return { errors: [`Cypher 条件长度不能超过 ${WHERE_CLAUSE_MAX_LENGTH} 个字符`] }
  }
  return { value: trimmed, errors: [] }
}

export function validateNeo4jExportRequest(input: unknown): Neo4jExportValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['Neo4j 导出请求必须是对象'] }
  }
  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const kind = validateNeo4jKind(input.kind)
  const name = validateNeo4jLabelOrType(input.name, kind.value === 'relationship' ? '关系类型' : '节点标签')
  const outputFile = validateFilePath(input.outputFile, '导出文件路径')
  const batchSize = validateBatchSize(input.batchSize)
  const where = validateNeo4jWhereClause(input.where)
  errors.push(
    ...connectionId.errors,
    ...kind.errors,
    ...name.errors,
    ...outputFile.errors,
    ...batchSize.errors,
    ...where.errors
  )
  if (
    errors.length > 0 ||
    !connectionId.value ||
    !kind.value ||
    !name.value ||
    !outputFile.value ||
    !batchSize.value
  ) {
    return { ok: false, errors }
  }
  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      kind: kind.value,
      name: name.value,
      outputFile: outputFile.value,
      batchSize: batchSize.value,
      ...(where.value !== undefined ? { where: where.value } : {})
    }
  }
}

export function validateNeo4jBatchExportRequest(input: unknown): Neo4jBatchExportValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['Neo4j 批量导出请求必须是对象'] }
  }
  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const kind = validateNeo4jKind(input.kind)
  const outputDirectory = validateFilePath(input.outputDirectory, '导出目录')
  const batchSize = validateBatchSize(input.batchSize)
  const where = validateNeo4jWhereClause(input.where)
  errors.push(
    ...connectionId.errors,
    ...kind.errors,
    ...outputDirectory.errors,
    ...batchSize.errors,
    ...where.errors
  )

  const labelName = kind.value === 'relationship' ? '关系类型' : '节点标签'
  const tables: string[] = []
  if (!Array.isArray(input.tables) || input.tables.length === 0) {
    errors.push(`至少选择一个${labelName}`)
  } else {
    for (const t of input.tables) {
      const result = validateNeo4jLabelOrType(t, labelName)
      errors.push(...result.errors)
      if (result.value) tables.push(result.value)
    }
  }
  if (
    errors.length > 0 ||
    !connectionId.value ||
    !kind.value ||
    !outputDirectory.value ||
    !batchSize.value
  ) {
    return { ok: false, errors }
  }
  return {
    ok: true,
    value: {
      connectionId: connectionId.value,
      kind: kind.value,
      tables,
      outputDirectory: outputDirectory.value,
      batchSize: batchSize.value,
      ...(where.value !== undefined ? { where: where.value } : {})
    }
  }
}

export function validateNeo4jCountNodesRequest(input: unknown): Neo4jCountNodesValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['Neo4j 节点行数统计请求必须是对象'] }
  }
  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const label = validateNeo4jLabelOrType(input.label, '节点标签')
  errors.push(...connectionId.errors, ...label.errors)
  if (errors.length > 0 || !connectionId.value || !label.value) {
    return { ok: false, errors }
  }
  return { ok: true, value: { connectionId: connectionId.value, label: label.value } }
}

export function validateNeo4jCountRelationshipsRequest(input: unknown): Neo4jCountRelationshipsValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['Neo4j 关系行数统计请求必须是对象'] }
  }
  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const type = validateNeo4jLabelOrType(input.type, '关系类型')
  errors.push(...connectionId.errors, ...type.errors)
  if (errors.length > 0 || !connectionId.value || !type.value) {
    return { ok: false, errors }
  }
  return { ok: true, value: { connectionId: connectionId.value, type: type.value } }
}

export function validateNeo4jConnectionTestRequest(input: unknown): Neo4jConnectionTestValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['Neo4j 连接测试请求必须是对象'] }
  }
  const connectionId = validateConnectionId(input.connectionId)
  if (connectionId.errors.length > 0 || !connectionId.value) {
    return { ok: false, errors: connectionId.errors }
  }
  return { ok: true, value: { connectionId: connectionId.value } }
}

// =====================================================
// Access (.accdb / .mdb) 校验器 — 与 SQLite 校验器同构
// =====================================================

export type AccessExportValidationResult =
  | { ok: true; value: AccessExportRequest }
  | { ok: false; errors: string[] }

export type AccessBatchExportValidationResult =
  | { ok: true; value: AccessBatchExportRequest }
  | { ok: false; errors: string[] }

export type AccessCountRowsValidationResult =
  | { ok: true; value: AccessCountRowsRequest }
  | { ok: false; errors: string[] }

export type AccessConnectionTestValidationResult =
  | { ok: true; value: { connectionId: string } }
  | { ok: false; errors: string[] }

function validateAccessTableRef(value: unknown): { value?: AccessTableRef; errors: string[] } {
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

function optionalAccessPassword(value: unknown): { value?: string; errors: string[] } {
  if (value === undefined || value === null) {
    return { errors: [] }
  }
  if (typeof value !== 'string') {
    return { errors: ['Access 密码必须是字符串'] }
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return { errors: [] }
  }
  if (trimmed.length > 64) {
    return { errors: ['Access 密码长度不能超过 64 个字符'] }
  }
  return { value: trimmed, errors: [] }
}

export function validateAccessExportRequest(input: unknown): AccessExportValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['Access 导出请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const table = validateAccessTableRef(input.table)
  const outputFile = validateFilePath(input.outputFile, '导出文件路径')
  const batchSize = validateBatchSize(input.batchSize)
  const password = optionalAccessPassword(input.password)
  errors.push(
    ...connectionId.errors,
    ...table.errors,
    ...outputFile.errors,
    ...batchSize.errors,
    ...password.errors
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
      batchSize: batchSize.value,
      ...(password.value !== undefined ? { password: password.value } : {})
    }
  }
}

export function validateAccessBatchExportRequest(input: unknown): AccessBatchExportValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['Access 批量导出请求必须是对象'] }
  }

  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const outputDirectory = validateFilePath(input.outputDirectory, '导出目录')
  const batchSize = validateBatchSize(input.batchSize)
  const password = optionalAccessPassword(input.password)
  errors.push(...connectionId.errors, ...outputDirectory.errors, ...batchSize.errors, ...password.errors)

  const tables: AccessTableRef[] = []
  if (!Array.isArray(input.tables) || input.tables.length === 0) {
    errors.push('至少选择一张表')
  } else {
    for (const t of input.tables) {
      const result = validateAccessTableRef(t)
      errors.push(...result.errors)
      if (result.value) {
        tables.push(result.value)
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
      ...(password.value !== undefined ? { password: password.value } : {})
    }
  }
}

export function validateAccessCountRowsRequest(input: unknown): AccessCountRowsValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['Access 行数统计请求必须是对象'] }
  }
  const errors: string[] = []
  const connectionId = validateConnectionId(input.connectionId)
  const table = validateAccessTableRef(input.table)
  errors.push(...connectionId.errors, ...table.errors)
  if (errors.length > 0 || !connectionId.value || !table.value) {
    return { ok: false, errors }
  }
  return { ok: true, value: { connectionId: connectionId.value, table: table.value } }
}

export function validateAccessConnectionTestRequest(input: unknown): AccessConnectionTestValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['Access 连接测试请求必须是对象'] }
  }
  const connectionId = validateConnectionId(input.connectionId)
  if (connectionId.errors.length > 0 || !connectionId.value) {
    return { ok: false, errors: connectionId.errors }
  }
  return { ok: true, value: { connectionId: connectionId.value } }
}

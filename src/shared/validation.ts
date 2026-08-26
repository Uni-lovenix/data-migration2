import {
  CONNECTION_TYPES,
  type ConnectionInput,
  type ConnectionType,
  type ElasticsearchConflictAction,
  type ElasticsearchExportRequest,
  type ElasticsearchImportRequest,
  type ElasticsearchReadStrategy,
  type PostgresConflictAction,
  type PostgresExportRequest,
  type PostgresImportRequest,
  type PostgresTableRef
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
    errors.push('连接类型必须是 postgresql 或 elasticsearch')
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

  return { ok: true, value }
}

export function connectionTypeLabel(type: ConnectionType): string {
  return type === 'postgresql' ? 'PostgreSQL' : 'Elasticsearch'
}

export function defaultPortForType(type: ConnectionType): number {
  return type === 'postgresql' ? 5432 : 9200
}

export type PostgresExportValidationResult =
  | { ok: true; value: PostgresExportRequest }
  | { ok: false; errors: string[] }

export type PostgresImportValidationResult =
  | { ok: true; value: PostgresImportRequest }
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
  errors.push(
    ...connectionId.errors,
    ...table.errors,
    ...outputFile.errors,
    ...batchSize.errors
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
      batchSize: batchSize.value
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
  errors.push(
    ...connectionId.errors,
    ...table.errors,
    ...inputFile.errors,
    ...batchSize.errors
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
      onConflict: input.onConflict === 'error' ? 'error' : 'skip'
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
  errors.push(...connectionId.errors, ...index.errors, ...outputFile.errors, ...batchSize.errors)
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
      strategy: input.strategy === 'search_after' ? 'search_after' : 'scroll'
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
  errors.push(...connectionId.errors, ...index.errors, ...inputFile.errors, ...batchSize.errors)
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
      onConflict: input.onConflict === 'overwrite' ? 'overwrite' : 'skip'
    }
  }
}

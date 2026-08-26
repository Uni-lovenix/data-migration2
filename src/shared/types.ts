export const CONNECTION_TYPES = ['postgresql', 'elasticsearch'] as const

export type ConnectionType = (typeof CONNECTION_TYPES)[number]

export interface ConnectionConfig {
  id: string
  name: string
  type: ConnectionType
  host: string
  port: number
  username?: string
  password?: string
  database?: string
  defaultIndex?: string
  ssl: boolean
  createdAt: string
  updatedAt: string
}

export interface ConnectionInput {
  name: string
  type: ConnectionType
  host: string
  port: number
  username?: string
  password?: string
  database?: string
  defaultIndex?: string
  ssl: boolean
}

export interface AppInfo {
  version: string
  platform: string
  arch: string
  userDataPath: string
}

export interface PostgresColumn {
  name: string
  dataType: string
  isNullable: boolean
  isPrimaryKey: boolean
  isGenerated: boolean
}

export interface PostgresTable {
  schema: string
  name: string
  columns: PostgresColumn[]
  estimatedRows: number | null
}

export interface PostgresTableRef {
  schema: string
  name: string
}

export interface PostgresConnectionTestResult {
  ok: boolean
  serverVersion?: string
  message?: string
}

export interface PostgresExportRequest {
  connectionId: string
  table: PostgresTableRef
  outputFile: string
  batchSize: number
}

export type PostgresConflictAction = 'error' | 'skip'

export interface PostgresImportRequest {
  connectionId: string
  table: PostgresTableRef
  inputFile: string
  batchSize: number
  onConflict: PostgresConflictAction
}

export interface PostgresMigrationResult {
  rows: number
  bytes?: number
  durationMs: number
  table: PostgresTableRef
}

export interface ElasticsearchField {
  name: string
  type: string
}

export interface ElasticsearchIndex {
  name: string
  health: string | null
  status: string | null
  docsCount: number | null
  storeSize: string | null
  aliases: string[]
  fields: ElasticsearchField[]
}

export interface ElasticsearchConnectionTestResult {
  ok: boolean
  serverVersion?: string
  supported?: boolean
  message?: string
}

export type ElasticsearchReadStrategy = 'scroll' | 'search_after'

export type ElasticsearchConflictAction = 'overwrite' | 'skip'

export interface ElasticsearchExportRequest {
  connectionId: string
  index: string
  outputFile: string
  batchSize: number
  strategy: ElasticsearchReadStrategy
}

export interface ElasticsearchImportRequest {
  connectionId: string
  index: string
  inputFile: string
  batchSize: number
  onConflict: ElasticsearchConflictAction
}

export interface ElasticsearchMigrationResult {
  rows: number
  skipped?: number
  bytes?: number
  durationMs: number
  index: string
}

export const MIGRATION_TASK_TYPES = [
  'postgres-export',
  'postgres-import',
  'elasticsearch-export',
  'elasticsearch-import'
] as const

export type MigrationTaskType = (typeof MIGRATION_TASK_TYPES)[number]

export type MigrationTaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled'

export type MigrationTaskPayload =
  | PostgresExportRequest
  | PostgresImportRequest
  | ElasticsearchExportRequest
  | ElasticsearchImportRequest

export interface MigrationTask {
  id: string
  type: MigrationTaskType
  status: MigrationTaskStatus
  connectionId: string
  payload: MigrationTaskPayload
  progress: number
  cursor?: unknown
  error?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

export interface CreateMigrationTaskInput {
  type: MigrationTaskType
  payload: MigrationTaskPayload
}

export type ViewKey = 'overview' | 'connections' | 'migration' | 'tasks'

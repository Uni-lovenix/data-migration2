export const CONNECTION_TYPES = [
  'postgresql',
  'elasticsearch',
  'mysql',
  'sqlite',
  'hive',
  'access',
  'neo4j'
] as const

export type ConnectionType = (typeof CONNECTION_TYPES)[number]

export const HIVE_AUTH_MODES = ['NONE', 'LDAP', 'KERBEROS', 'CUSTOM'] as const
export type HiveAuth = (typeof HIVE_AUTH_MODES)[number]

export const HIVE_TRANSPORT_MODES = ['binary', 'http'] as const
export type HiveTransportMode = (typeof HIVE_TRANSPORT_MODES)[number]

export const FIELD_TRANSFORM_STRATEGIES = [
  'json',
  'cast',
  'stringify',
  'skip'
] as const
export type FieldTransformStrategy = (typeof FIELD_TRANSFORM_STRATEGIES)[number]

export interface FieldTransform {
  sourceColumn: string
  sourceType: string
  targetColumn?: string
  targetType: string
  strategy: FieldTransformStrategy
  options?: Record<string, unknown>
}

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
  /** SQLite only: absolute path to the database file. */
  filePath?: string
  /** HiveServer2 authentication mechanism. */
  auth?: HiveAuth
  /** HiveServer2 transport mode. */
  transportMode?: HiveTransportMode
  /** HiveServer2 HTTP endpoint path, for example /cliservice. */
  httpPath?: string
  /** Neo4j Bolt URI. Optional override for host/port/ssl. */
  uri?: string
  ssl: boolean
  /** MySQL only: path to a PEM CA bundle. Only used when `ssl` is true. */
  sslCa?: string
  /** MySQL only: path to a PEM client certificate. Only used when `ssl` is true. */
  sslCert?: string
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
  /** SQLite only: absolute path to the database file. */
  filePath?: string
  /** HiveServer2 authentication mechanism. */
  auth?: HiveAuth
  /** HiveServer2 transport mode. */
  transportMode?: HiveTransportMode
  /** HiveServer2 HTTP endpoint path, for example /cliservice. */
  httpPath?: string
  /** Neo4j Bolt URI. Optional override for host/port/ssl. */
  uri?: string
  ssl: boolean
  sslCa?: string
  sslCert?: string
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
  database?: string
  /** Optional SQL predicate fragment (no WHERE keyword). Empty = no filter. */
  where?: string
}

export interface PostgresBatchExportRequest {
  connectionId: string
  tables: PostgresTableRef[]
  outputDirectory: string
  batchSize: number
  database?: string
  /** Optional SQL predicate fragment (no WHERE keyword). Applied to every table. */
  where?: string
}

export interface PostgresCountRowsRequest {
  connectionId: string
  table: PostgresTableRef
  database?: string
}

export type PostgresConflictAction = 'error' | 'skip'

export interface PostgresImportRequest {
  connectionId: string
  table: PostgresTableRef
  inputFile: string
  batchSize: number
  onConflict: PostgresConflictAction
  database?: string
  /** Optional import projection. Empty/omitted imports all source columns. */
  selectedColumns?: string[]
  fieldTransforms?: FieldTransform[]
}

export interface PostgresMigrationResult {
  rows: number
  bytes?: number
  durationMs: number
  table: PostgresTableRef
}

export interface PostgresBatchMigrationResult {
  rows: number
  bytes: number
  durationMs: number
  tables: PostgresMigrationResult[]
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

export type ElasticsearchMappingSource = 'sidecar' | 'inline'

export interface ElasticsearchMappingConfig {
  /** 'inline' overrides sidecar when both are provided. */
  source: ElasticsearchMappingSource
  /** Inline mapping JSON. Only honored when source === 'inline'. */
  inlineJson?: string
  /** Override path for the sidecar file. Defaults to <inputFile>.mapping.json. */
  sidecarPath?: string
}

export interface ElasticsearchExportRequest {
  connectionId: string
  index: string
  outputFile: string
  batchSize: number
  /** Maximum concurrent ES search requests. Defaults to 1. */
  concurrency?: number
  strategy: ElasticsearchReadStrategy
  /** Raw ES Query DSL JSON. Empty/missing = match_all. */
  query?: string
  /** Write <outputFile>.mapping.json sidecar after data export. Defaults to true. */
  exportMapping?: boolean
}

export interface ElasticsearchImportRequest {
  connectionId: string
  index: string
  inputFile: string
  batchSize: number
  /** Maximum concurrent ES bulk requests. Defaults to 1. */
  concurrency?: number
  onConflict: ElasticsearchConflictAction
  /** Create the target index using the mapping body when it is missing. Defaults to true. */
  createIndex?: boolean
  /** Mapping source. Omit to auto-detect <inputFile>.mapping.json. */
  mapping?: ElasticsearchMappingConfig
  /** Optional import projection. Empty/omitted imports all source fields. */
  selectedColumns?: string[]
  fieldTransforms?: FieldTransform[]
}

export interface ElasticsearchMigrationResult {
  rows: number
  skipped?: number
  bytes?: number
  durationMs: number
  index: string
  /** Sidecar file path (export) or mapping file used (import). */
  mappingFile?: string
  /** Import only: whether the target index was created in this run. */
  indexCreated?: boolean
}

// =====================================================
// MySQL（Source Connector，Node.js 侧实现，与 PostgresService 接口对齐）
// =====================================================

export interface MySQLColumn {
  name: string
  /** COLUMN_TYPE，例如 varchar(255) / int unsigned。 */
  dataType: string
  isNullable: boolean
  isPrimaryKey: boolean
  isGenerated: boolean
}

export interface MySQLTable {
  /**
   * MySQL 没有 schema 概念，该字段始终为 database 名（与 PostgresTable.schema 对齐，
   * 以便复用同一套表选择 / JSONL 信封逻辑）。
   */
  schema: string
  name: string
  columns: MySQLColumn[]
  /** information_schema.TABLES.TABLE_ROWS，InnoDB 下为近似值。 */
  estimatedRows: number | null
}

export interface MySQLTableRef {
  /** 数据库名（MySQL 没有独立 schema 概念）。 */
  schema: string
  name: string
}

export interface MySQLConnectionTestResult {
  ok: boolean
  serverVersion?: string
  message?: string
}

export interface MySQLExportRequest {
  connectionId: string
  table: MySQLTableRef
  outputFile: string
  batchSize: number
  database?: string
}

export interface MySQLBatchExportRequest {
  connectionId: string
  tables: MySQLTableRef[]
  outputDirectory: string
  batchSize: number
  database?: string
}

export interface MySQLCountRowsRequest {
  connectionId: string
  table: MySQLTableRef
  database?: string
}

export type MySQLConflictAction = 'error' | 'skip' | 'update'

export interface MySQLImportRequest {
  connectionId: string
  table: MySQLTableRef
  inputFile: string
  batchSize: number
  onConflict: MySQLConflictAction
  database?: string
  /** Optional import projection. Empty/omitted imports all source columns. */
  selectedColumns?: string[]
  fieldTransforms?: FieldTransform[]
}

export interface MySQLMigrationResult {
  rows: number
  bytes?: number
  durationMs: number
  table: MySQLTableRef
}

export interface MySQLBatchMigrationResult {
  rows: number
  bytes: number
  durationMs: number
  tables: MySQLMigrationResult[]
}

// =====================================================
// SQLite Source Connector（Node.js 侧实现）
// =====================================================

export interface SQLiteColumn {
  name: string
  dataType: string
  isNullable: boolean
  isPrimaryKey: boolean
  isGenerated: boolean
}

export interface SQLiteTable {
  /** SQLite schema，默认 main。 */
  schema: string
  name: string
  columns: SQLiteColumn[]
  estimatedRows: number | null
}

export interface SQLiteTableRef {
  schema: string
  name: string
}

export interface SQLiteConnectionTestResult {
  ok: boolean
  serverVersion?: string
  message?: string
}

export interface SQLiteCountRowsRequest {
  connectionId: string
  table: SQLiteTableRef
}

export interface SQLiteExportRequest {
  connectionId: string
  table: SQLiteTableRef
  outputFile: string
  batchSize: number
}

export interface SQLiteBatchExportRequest {
  connectionId: string
  tables: SQLiteTableRef[]
  outputDirectory: string
  batchSize: number
}

export interface SQLiteMigrationResult {
  rows: number
  bytes?: number
  durationMs: number
  table: SQLiteTableRef
}

export interface SQLiteBatchMigrationResult {
  rows: number
  bytes: number
  durationMs: number
  tables: SQLiteMigrationResult[]
}

// =====================================================
// Hive Source Connector（HiveServer2 Thrift / HTTP）
// =====================================================

export interface HiveTable {
  database: string
  name: string
}

export interface HiveConnectionTestResult {
  ok: boolean
  serverVersion?: string
  transportMode?: HiveTransportMode
  message?: string
}

export interface HiveCountRowsRequest {
  connectionId: string
  table: HiveTable
}

export interface HiveExportRequest {
  connectionId: string
  table: HiveTable
  outputFile: string
  batchSize: number
}

export interface HiveImportRequest {
  connectionId: string
  table: HiveTable
  inputFile: string
  batchSize: number
  /** Optional import projection. Empty/omitted imports all source columns. */
  selectedColumns?: string[]
  fieldTransforms?: FieldTransform[]
}

export interface HiveMigrationResult {
  rows: number
  skipped?: number
  warnings?: string[]
  bytes?: number
  durationMs: number
  table: HiveTable
}

// =====================================================
// Microsoft Access Source Connector（Go + mdbtools 子进程）
// =====================================================

export interface AccessConnectionTestResult {
  ok: boolean
  message?: string
  tables?: string[]
}

export interface AccessExportRequest {
  connectionId: string
  table: string
  outputFile: string
  batchSize: number
}

export interface AccessMigrationResult {
  rows: number
  bytes?: number
  durationMs: number
  table: string
}

// =====================================================
// Atomic orchestration contracts
// =====================================================

export type AtomSourceType =
  | 'postgresql'
  | 'mysql'
  | 'elasticsearch'
  | 'hive'
  | 'sqlite'

export type AtomTargetType =
  | 'postgresql'
  | 'mysql'
  | 'elasticsearch'
  | 'hive'

export interface ExportPreviewRequest {
  source: AtomSourceType
  connectionId: string
  limit: number
  table?: PostgresTableRef | MySQLTableRef | HiveTable
  index?: string
}

export interface ExportPreviewResult {
  source: AtomSourceType
  columns: string[]
  rows: Array<Record<string, unknown>>
}

export interface ImportValidateRequest {
  target: AtomTargetType
  connectionId: string
  columns: string[]
  table?: PostgresTableRef | MySQLTableRef | HiveTable
  index?: string
}

export interface ImportValidateResult {
  target: AtomTargetType
  ok: true
  missingColumns: string[]
  existingColumns?: string[]
}

export interface CastDryRunRequest {
  row: Record<string, unknown>
  transforms: FieldTransform[]
  targetTypes?: Record<string, string>
}

export interface CastDryRunResult {
  row: Record<string, unknown>
}

export interface OrchestrationStep {
  atom: string
  [key: string]: unknown
}

export interface OrchestrationStepResult {
  index: number
  atom: string
  status: 'completed' | 'failed' | 'skipped'
  result?: unknown
  error?: string
}

export interface OrchestrationResult {
  steps: OrchestrationStepResult[]
  summary: {
    total: number
    completed: number
    failed: number
    skipped: number
  }
}

// Neo4j Source Connector contract.
export interface Neo4jColumn {
  name: string
  dataType: string
  isNullable: boolean
  isPrimaryKey: boolean
  isPartitionColumn: boolean
}

export type Neo4jTableKind = 'node' | 'relationship'

export interface Neo4jTable {
  kind: Neo4jTableKind
  name: string
  columns: Neo4jColumn[]
  estimatedRows: number | null
  partitionColumns: string[]
}

export interface Neo4jTableRef {
  kind: Neo4jTableKind
  name: string
}

export interface Neo4jConnectionTestResult {
  ok: boolean
  serverVersion?: string
  message?: string
}

export interface Neo4jLabelSummary {
  label: string
  count: number
}

export interface Neo4jRelationshipTypeSummary {
  type: string
  count: number
}

export interface Neo4jExportRequest {
  connectionId: string
  kind: Neo4jTableKind
  name: string
  outputFile: string
  batchSize: number
  /** Optional Cypher WHERE fragment without the WHERE keyword. */
  where?: string
}

export interface Neo4jBatchExportRequest {
  connectionId: string
  kind: Neo4jTableKind
  tables: string[]
  outputDirectory: string
  batchSize: number
  /** Optional Cypher WHERE fragment without the WHERE keyword. */
  where?: string
}

export interface Neo4jCountNodesRequest {
  connectionId: string
  label: string
}

export interface Neo4jCountRelationshipsRequest {
  connectionId: string
  type: string
}

export interface Neo4jMigrationResult {
  rows: number
  bytes?: number
  durationMs: number
  table: Neo4jTableRef
}

export interface Neo4jBatchMigrationResult {
  rows: number
  bytes: number
  durationMs: number
  tables: Neo4jMigrationResult[]
}

export const MIGRATION_TASK_TYPES = [
  'postgres-export',
  'postgres-export-batch',
  'postgres-import',
  'elasticsearch-export',
  'elasticsearch-import',
  'mysql-export',
  'mysql-export-batch',
  'mysql-import',
  'sqlite-export',
  'sqlite-export-batch',
  'hive-export',
  'hive-import',
  'neo4j-export',
  'access-export'
] as const

export type MigrationTaskType = (typeof MIGRATION_TASK_TYPES)[number]

export type MigrationTaskStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled'

export type MigrationTaskPayload =
  | PostgresExportRequest
  | PostgresBatchExportRequest
  | PostgresImportRequest
  | ElasticsearchExportRequest
  | ElasticsearchImportRequest
  | MySQLExportRequest
  | MySQLBatchExportRequest
  | MySQLImportRequest
  | SQLiteExportRequest
  | SQLiteBatchExportRequest
  | HiveExportRequest
  | HiveImportRequest
  | Neo4jExportRequest
  | AccessExportRequest

export interface MigrationTask {
  id: string
  type: MigrationTaskType
  status: MigrationTaskStatus
  connectionId: string
  payload: MigrationTaskPayload
  dependsOn?: string[]
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
  /**
   * Task ids that must complete before this task becomes runnable.
   */
  dependsOn?: string[]
  /**
   * When false, persist the task without enqueueing it. Defaults to true so
   * existing callers keep their fire-and-run behavior.
   */
  start?: boolean
}

export const TEMPLATE_ENGINES = [
  'pgmigrator',
  'esmigrator',
  'mysqlmigrator',
  'sqlitemigrator',
  'hivemigrator',
  'neo4jmigrator',
  'accessmigrator'
] as const

export type TemplateEngine = (typeof TEMPLATE_ENGINES)[number]
export type TemplateAction = 'export' | 'import'

// Template variable for placeholder substitution
export interface TemplateVariable {
  name: string
  defaultValue?: string
  description?: string
}

// One step inside a multi-step template (or the sole task of a single-step template).
// Each step resolves into its own migration task at execute time. Sequential order
// is preserved through task dependencies.
export interface TemplateStep {
  id: string // stable uuid used for React keys
  name?: string // optional display label in the step list
  engine: TemplateEngine
  action: TemplateAction
  connectionName: string
  dstConnectionName?: string
  configJson: string // JSON string with {{VAR}} placeholders
  variables?: TemplateVariable[] // step-local vars, merged on top of template-level vars
}

// Template stored in SQLite
export interface MigrationTemplate {
  id: string
  name: string
  description?: string
  engine: TemplateEngine
  action: TemplateAction
  connectionName: string
  dstConnectionName?: string
  configJson: string // JSON string with {{VAR}} placeholders
  variables: TemplateVariable[]
  // Ordered list of additional steps. Empty array = single-task template (legacy behavior).
  // When `steps` is non-empty, top-level engine/action/connectionName/configJson are
  // ignored at execute time and each step becomes its own dependent task.
  steps: TemplateStep[]
  createdAt: string
  updatedAt: string
}

export interface CreateTemplateInput {
  name: string
  description?: string
  engine: TemplateEngine
  action: TemplateAction
  connectionName: string
  dstConnectionName?: string
  configJson: string
  variables?: TemplateVariable[]
  steps?: TemplateStep[]
}

export interface UpdateTemplateInput {
  name?: string
  description?: string
  connectionName?: string
  dstConnectionName?: string
  configJson?: string
  variables?: TemplateVariable[]
  steps?: TemplateStep[]
}

// LLM Provider types
export type LLMProvider = 'ollama' | 'anthropic' | 'openai'

export interface LLMConfig {
  id: string
  name: string
  provider: LLMProvider
  apiBase?: string // Ollama base URL, e.g. http://localhost:11434
  apiKey?: string // Masked when retrieved
  model: string
  extra?: Record<string, string> // Provider-specific extra config
  refreshToken?: string // For OAuth token refresh
  expiresAt?: string // ISO date when token expires
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface LLMConfigInput {
  name: string
  provider: LLMProvider
  apiBase?: string
  apiKey?: string
  model: string
  extra?: Record<string, string>
  enabled?: boolean
}

export interface UpdateLLMConfigInput {
  name?: string
  provider?: LLMProvider
  apiBase?: string
  apiKey?: string
  model?: string
  extra?: Record<string, string>
  enabled?: boolean
}

// API Token for external REST API access
export interface APIToken {
  token: string
  label: string
  createdAt: string
}

// LLM Chat
export interface LLMChatRequest {
  model?: string
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  maxTokens?: number
  temperature?: number
}

export interface LLMChatResponse {
  message: { role: 'assistant'; content: string }
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

// =====================================================
// Agentic chat (function calling) — 参考 AIIP agent.py
// =====================================================

export type AgentRole = 'system' | 'user' | 'assistant' | 'tool'

export interface AgentMessage {
  id: string
  sessionId: string
  role: AgentRole
  content: string | null
  toolCallId?: string
  toolName?: string
  toolArgs?: string
  toolResult?: string
  createdAt: string
}

export interface AgentSession {
  id: string
  title: string
  llmConfigId?: string
  createdAt: string
  updatedAt: string
}

export interface AgentSessionInput {
  title?: string
  llmConfigId?: string
}

export interface AgentChatRequest {
  sessionId: string
  userMessage: string
}

export interface AgentChatResponse {
  sessionId: string
  reply: string
  toolCalls: Array<{
    name: string
    args: Record<string, unknown>
    result: unknown
  }>
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

// =====================================================
// API Token（独立于 LLM 的工具调用 token）
// =====================================================

export interface ApiToken {
  id: string
  label: string
  token: string // 仅在创建时返回完整值
  masked: string
  createdAt: string
  lastUsedAt?: string
}

export interface ApiTokenInput {
  label: string
}

export interface ApiTokenView {
  id: string
  label: string
  masked: string
  createdAt: string
  lastUsedAt?: string
}

// =====================================================
// REST API 调用结果（供 Token-In 页面使用）
// =====================================================

export interface ApiCallResult<T = unknown> {
  ok: boolean
  status: number
  data?: T
  error?: string
}

export type ViewKey =
  | 'overview'
  | 'connections'
  | 'migration'
  | 'tasks'
  | 'templates'
  | 'llm'
  | 'agent'
  | 'token-in'

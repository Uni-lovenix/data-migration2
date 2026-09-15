export const CONNECTION_TYPES = [
  'postgresql',
  'elasticsearch',
  'mysql',
  'sqlite',
  'hive',
  'neo4j',
  'access'
] as const

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
  /** SQLite 数据库文件绝对路径（仅 type === 'sqlite' 时使用） */
  filePath?: string
  /** Hive 认证方式（仅 type === 'hive' 时使用） */
  auth?: 'NONE' | 'LDAP' | 'KERBEROS' | 'CUSTOM'
  /** Hive 传输模式（仅 type === 'hive' 时使用；默认 http） */
  transportMode?: 'binary' | 'http'
  /** HiveServer2 HTTP mode 端点路径（仅 type === 'hive' 时使用） */
  httpPath?: string
  /** Neo4j Bolt URI（仅 type === 'neo4j' 时使用，可选覆盖 host/port/ssl） */
  uri?: string
  /** Access 数据库密码（仅 type === 'access' 时使用，加密 .mdb 可选） */
  filePassword?: string
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
  /** SQLite 数据库文件绝对路径（仅 type === 'sqlite' 时使用） */
  filePath?: string
  /** Hive 认证方式（仅 type === 'hive' 时使用） */
  auth?: 'NONE' | 'LDAP' | 'KERBEROS' | 'CUSTOM'
  /** Hive 传输模式（仅 type === 'hive' 时使用；默认 http） */
  transportMode?: 'binary' | 'http'
  /** HiveServer2 HTTP mode 端点路径（仅 type === 'hive' 时使用） */
  httpPath?: string
  /** Neo4j Bolt URI（仅 type === 'neo4j' 时使用，可选覆盖 host/port/ssl） */
  uri?: string
  /** Access 数据库密码（仅 type === 'access' 时使用，加密 .mdb 可选） */
  filePassword?: string
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
  /**
   * Optional column projection (column pruning). When present, the importer
   * only writes the listed source columns into the target table; columns
   * missing from the selection are written as NULL (or skipped when the
   * database driver supports column omission). Undefined = import all columns.
   */
  selectedColumns?: string[]
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

// =====================================================
// MySQL — 与 PostgresService 同构：相同 JSONL 信封
// =====================================================

export interface MySQLColumn {
  name: string
  dataType: string
  isNullable: boolean
  isPrimaryKey: boolean
}

export interface MySQLTable {
  /** MySQL 没有 schema 概念；该字段始终为连接的 database 名 */
  schema: string
  name: string
  columns: MySQLColumn[]
  /** 来自 information_schema.TABLES.TABLE_ROWS；InnoDB 为近似值 */
  estimatedRows: number | null
}

export interface MySQLTableRef {
  name: string
  /** MySQL 没有 schema 概念；该字段指向 table 所属的 database 名 */
  schema?: string
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
// SQLite — 与 PostgresService / MySQLService 同构
// =====================================================

export interface SQLiteColumn {
  name: string
  dataType: string
  isNullable: boolean
  isPrimaryKey: boolean
  isGenerated: boolean
  defaultValue: string | null
}

export interface SQLiteTable {
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

export interface SQLiteCountRowsRequest {
  connectionId: string
  table: SQLiteTableRef
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
// Hive — HiveServer2 导出（与 PostgresService / MySQLService JSONL 信封同构）
// =====================================================

export interface HiveColumn {
  name: string
  /** 完整 Hive 类型字符串，如 "array<int>" / "map<string,int>" / "struct<a:int,b:string>" */
  dataType: string
  isNullable: boolean
  /** Hive 没有原生主键概念；保留字段以与 PG/MySQL DTO 对称 */
  isPrimaryKey: boolean
  /** 是否为分区列（Hive 特有） */
  isPartitionColumn: boolean
}

export interface HiveTable {
  database: string
  name: string
  columns: HiveColumn[]
  /** 分区列名列表（Hive 特有） */
  partitionColumns: string[]
  estimatedRows: number | null
}

export interface HiveTableRef {
  database: string
  name: string
}

export interface HiveConnectionTestResult {
  ok: boolean
  serverVersion?: string
  message?: string
}

export interface HiveExportRequest {
  connectionId: string
  database: string
  table: string
  outputFile: string
  batchSize: number
  /** 可选 SQL WHERE 片段（不含 WHERE 关键字） */
  where?: string
}

export interface HiveBatchExportRequest {
  connectionId: string
  database: string
  tables: string[]
  outputDirectory: string
  batchSize: number
  /** 可选 SQL WHERE 片段（不含 WHERE 关键字） */
  where?: string
}

export interface HiveCountRowsRequest {
  connectionId: string
  database: string
  table: string
}

export interface HiveMigrationResult {
  rows: number
  bytes?: number
  durationMs: number
  table: HiveTableRef
}

export interface HiveBatchMigrationResult {
  rows: number
  bytes: number
  durationMs: number
  tables: HiveMigrationResult[]
}

// =====================================================
// Neo4j — 与 PostgresService / MySQLService JSONL 信封同构（双信封）
// =====================================================
//
// 双信封设计：节点导出行 `{_id, _labels, properties}` 与关系导出行
// `{_id, _type, _src, _dst, properties}` 完全对齐 ES `_source` 信封；
// properties 已通过 Neo4jService.normalizeNeo4jValue 集中归一化
//（Point → JSON、Node → JSON、Date → ISO 字符串）。

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
  /** 可选 Cypher WHERE 片段（不含 WHERE 关键字） */
  where?: string
}

export interface Neo4jBatchExportRequest {
  connectionId: string
  kind: Neo4jTableKind
  tables: string[]
  outputDirectory: string
  batchSize: number
  /** 可选 Cypher WHERE 片段（不含 WHERE 关键字） */
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

// =====================================================
// Access (.accdb / .mdb) — 与 SQLite 单文件无服务器同构；走 Go 子进程
// =====================================================
//
// JSONL 信封与 PG/MySQL/SQLite/Neo4j/Hive 完全兼容：
// `{table: {schema: 'Access', name: '<table>'}, columns: string[], rows: any[][]}`
// 标量类型保持原值；复杂类型（OLE 包装 / Attachment / Memo > 64KB 等）序列化为 JSON 字符串。

export interface AccessColumn {
  name: string
  dataType: string
  isNullable: boolean
  isPrimaryKey: boolean
}

export interface AccessTable {
  schema: string
  name: string
  columns: AccessColumn[]
  estimatedRows: number | null
}

export interface AccessTableRef {
  schema: string
  name: string
}

export interface AccessConnectionTestResult {
  ok: boolean
  serverVersion?: string
  /** 'accdb' / 'mdb' / undefined（无法识别） */
  fileFormat?: string
  /** 数据库中表数量 */
  tableCount?: number
  message?: string
}

export interface AccessExportRequest {
  connectionId: string
  table: AccessTableRef
  outputFile: string
  batchSize: number
  /** 可选密码覆盖（用于加密 .mdb 在导出时临时覆盖连接中保存的密码） */
  password?: string
}

export interface AccessBatchExportRequest {
  connectionId: string
  tables: AccessTableRef[]
  outputDirectory: string
  batchSize: number
  /** 可选密码覆盖 */
  password?: string
}

export interface AccessCountRowsRequest {
  connectionId: string
  table: AccessTableRef
}

export interface AccessMigrationResult {
  rows: number
  bytes?: number
  durationMs: number
  table: AccessTableRef
}

export interface AccessBatchMigrationResult {
  rows: number
  bytes: number
  durationMs: number
  tables: AccessMigrationResult[]
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
  onConflict: ElasticsearchConflictAction
  /** Create the target index using the mapping body when it is missing. Defaults to true. */
  createIndex?: boolean
  /** Mapping source. Omit to auto-detect <inputFile>.mapping.json. */
  mapping?: ElasticsearchMappingConfig
  /**
   * Optional field projection. When present, the bulk request only contains
   * the listed source fields in the `_source` body; unselected fields are
   * stripped before serialization. Undefined = import all fields. `_id` is
   * always preserved.
   */
  selectedColumns?: string[]
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

export const MIGRATION_TASK_TYPES = [
  'postgres-export',
  'postgres-export-batch',
  'postgres-import',
  'elasticsearch-export',
  'elasticsearch-import',
  'mysql-export',
  'mysql-export-batch',
  'sqlite-export',
  'sqlite-export-batch',
  'hive-export',
  'hive-export-batch',
  'neo4j-export',
  'neo4j-export-batch',
  'access-export',
  'access-export-batch'
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
  | PostgresBatchExportRequest
  | PostgresImportRequest
  | ElasticsearchExportRequest
  | ElasticsearchImportRequest
  | MySQLExportRequest
  | MySQLBatchExportRequest
  | SQLiteExportRequest
  | SQLiteBatchExportRequest
  | HiveExportRequest
  | HiveBatchExportRequest
  | Neo4jExportRequest
  | Neo4jBatchExportRequest
  | AccessExportRequest
  | AccessBatchExportRequest

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


// Template variable for placeholder substitution
export interface TemplateVariable {
  name: string
  defaultValue?: string
  description?: string
}

// One step inside a multi-step template (or the sole task of a single-step template).
// Each step resolves into its own migration task at execute time. Sequential order
// is preserved by the FIFO task queue.
export interface TemplateStep {
  id: string // stable uuid used for React keys
  name?: string // optional display label in the step list
  engine: 'pgmigrator' | 'esmigrator'
  action: 'export' | 'import'
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
  engine: 'pgmigrator' | 'esmigrator'
  action: 'export' | 'import'
  connectionName: string
  dstConnectionName?: string
  configJson: string // JSON string with {{VAR}} placeholders
  variables: TemplateVariable[]
  // Ordered list of additional steps. Empty array = single-task template (legacy behavior).
  // When `steps` is non-empty, top-level engine/action/connectionName/configJson are
  // ignored at execute time and each step becomes its own task in the FIFO queue.
  steps: TemplateStep[]
  createdAt: string
  updatedAt: string
}

export interface CreateTemplateInput {
  name: string
  description?: string
  engine: 'pgmigrator' | 'esmigrator'
  action: 'export' | 'import'
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

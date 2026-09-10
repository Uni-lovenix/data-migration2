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
  database?: string
}

export interface PostgresBatchExportRequest {
  connectionId: string
  tables: PostgresTableRef[]
  outputDirectory: string
  batchSize: number
  database?: string
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
  'postgres-export-batch',
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
  | PostgresBatchExportRequest
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


// Template variable for placeholder substitution
export interface TemplateVariable {
  name: string
  defaultValue?: string
  description?: string
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
}

export interface UpdateTemplateInput {
  name?: string
  description?: string
  connectionName?: string
  dstConnectionName?: string
  configJson?: string
  variables?: TemplateVariable[]
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

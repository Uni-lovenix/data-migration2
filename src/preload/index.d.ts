import type {
  AgentChatRequest,
  AgentChatResponse,
  AgentMessage,
  AgentSession,
  AgentSessionInput,
  ApiToken,
  ApiTokenInput,
  ApiTokenView,
  AppInfo,
  ConnectionConfig,
  ConnectionInput,
  CreateMigrationTaskInput,
  CreateTemplateInput,
  ElasticsearchConnectionTestResult,
  ElasticsearchExportRequest,
  ElasticsearchImportRequest,
  ElasticsearchIndex,
  ElasticsearchMigrationResult,
  HiveConnectionTestResult,
  HiveCountRowsRequest,
  HiveExportRequest,
  HiveImportRequest,
  HiveMigrationResult,
  HiveTable,
  LLMChatRequest,
  LLMChatResponse,
  LLMConfig,
  LLMConfigInput,
  MigrationTemplate,
  MigrationTask,
  MySQLBatchExportRequest,
  MySQLBatchMigrationResult,
  MySQLConnectionTestResult,
  MySQLCountRowsRequest,
  MySQLExportRequest,
  MySQLImportRequest,
  MySQLMigrationResult,
  MySQLTable,
  Neo4jConnectionTestResult,
  Neo4jCountNodesRequest,
  Neo4jCountRelationshipsRequest,
  Neo4jExportRequest,
  Neo4jMigrationResult,
  PostgresConnectionTestResult,
  PostgresBatchExportRequest,
  PostgresBatchMigrationResult,
  PostgresCountRowsRequest,
  PostgresExportRequest,
  PostgresImportRequest,
  PostgresMigrationResult,
  PostgresTable,
  SQLiteBatchExportRequest,
  SQLiteBatchMigrationResult,
  SQLiteConnectionTestResult,
  SQLiteCountRowsRequest,
  SQLiteExportRequest,
  SQLiteMigrationResult,
  SQLiteTable,
  UpdateLLMConfigInput,
  UpdateTemplateInput
} from '../shared/types'

interface AgentSessionDetail {
  session: AgentSession
  messages: AgentMessage[]
}

interface RestApiResponse {
  ok: boolean
  status: number
  data: unknown
}

declare global {
  interface Window {
    api: {
      app: {
        getInfo: () => Promise<AppInfo>
      }
      connections: {
        list: () => Promise<ConnectionConfig[]>
        create: (input: ConnectionInput) => Promise<ConnectionConfig>
        update: (id: string, input: ConnectionInput) => Promise<ConnectionConfig>
        delete: (id: string) => Promise<void>
      }
      postgres: {
        test: (
          connectionId: string,
          database?: string
        ) => Promise<PostgresConnectionTestResult>
        databases: (connectionId: string) => Promise<string[]>
        tables: (
          connectionId: string,
          database?: string
        ) => Promise<PostgresTable[]>
        countRows: (request: PostgresCountRowsRequest) => Promise<number>
        export: (request: PostgresExportRequest) => Promise<PostgresMigrationResult>
        exportTables: (
          request: PostgresBatchExportRequest
        ) => Promise<PostgresBatchMigrationResult>
        import: (request: PostgresImportRequest) => Promise<PostgresMigrationResult>
      }
      elasticsearch: {
        test: (connectionId: string) => Promise<ElasticsearchConnectionTestResult>
        indices: (connectionId: string) => Promise<ElasticsearchIndex[]>
        export: (request: ElasticsearchExportRequest) => Promise<ElasticsearchMigrationResult>
        import: (request: ElasticsearchImportRequest) => Promise<ElasticsearchMigrationResult>
      }
      mysql: {
        test: (connectionId: string, database?: string) => Promise<MySQLConnectionTestResult>
        databases: (connectionId: string) => Promise<string[]>
        tables: (connectionId: string, database?: string) => Promise<MySQLTable[]>
        countRows: (request: MySQLCountRowsRequest) => Promise<number>
        export: (request: MySQLExportRequest) => Promise<MySQLMigrationResult>
        exportTables: (request: MySQLBatchExportRequest) => Promise<MySQLBatchMigrationResult>
        import: (request: MySQLImportRequest) => Promise<MySQLMigrationResult>
      }
      sqlite: {
        test: (connectionId: string) => Promise<SQLiteConnectionTestResult>
        tables: (connectionId: string) => Promise<SQLiteTable[]>
        countRows: (request: SQLiteCountRowsRequest) => Promise<number>
        export: (request: SQLiteExportRequest) => Promise<SQLiteMigrationResult>
        exportTables: (
          request: SQLiteBatchExportRequest
        ) => Promise<SQLiteBatchMigrationResult>
      }
      hive: {
        test: (connectionId: string) => Promise<HiveConnectionTestResult>
        databases: (connectionId: string) => Promise<string[]>
        tables: (connectionId: string, database: string) => Promise<HiveTable[]>
        countRows: (request: HiveCountRowsRequest) => Promise<number>
        export: (request: HiveExportRequest) => Promise<HiveMigrationResult>
        import: (request: HiveImportRequest) => Promise<HiveMigrationResult>
      }
      neo4j: {
        test: (connectionId: string) => Promise<Neo4jConnectionTestResult>
        labels: (connectionId: string) => Promise<string[]>
        relationshipTypes: (connectionId: string) => Promise<string[]>
        countNodes: (request: Neo4jCountNodesRequest) => Promise<number>
        countRelationships: (request: Neo4jCountRelationshipsRequest) => Promise<number>
        export: (request: Neo4jExportRequest) => Promise<Neo4jMigrationResult>
      }
      tasks: {
        list: () => Promise<MigrationTask[]>
        create: (input: CreateMigrationTaskInput) => Promise<MigrationTask>
        cancel: (id: string) => Promise<MigrationTask>
        resume: (id: string) => Promise<MigrationTask>
        onChanged: (callback: (task: MigrationTask) => void) => () => void
      }
      dialog: {
        chooseExportFile: (suggestedName: string) => Promise<string | null>
        chooseExportDirectory: () => Promise<string | null>
        chooseImportFile: () => Promise<string | null>
        chooseSQLiteFile: () => Promise<string | null>
      }
      templates: {
        list: () => Promise<MigrationTemplate[]>
        get: (id: string) => Promise<MigrationTemplate>
        create: (input: CreateTemplateInput) => Promise<MigrationTemplate>
        update: (id: string, input: UpdateTemplateInput) => Promise<MigrationTemplate>
        delete: (id: string) => Promise<void>
        execute: (id: string, vars?: Record<string, string>) => Promise<{ taskId: string }>
        executeMany: (
          requests: Array<{ id: string; vars?: Record<string, string> }>
        ) => Promise<Array<{ taskId: string }>>
      }
      llm: {
        list: () => Promise<LLMConfig[]>
        get: (id: string) => Promise<LLMConfig>
        create: (input: LLMConfigInput) => Promise<LLMConfig>
        update: (id: string, input: UpdateLLMConfigInput) => Promise<LLMConfig>
        delete: (id: string) => Promise<void>
        chat: (id: string, request: LLMChatRequest) => Promise<LLMChatResponse>
      }
      agent: {
        listSessions: () => Promise<AgentSession[]>
        getSession: (id: string) => Promise<AgentSessionDetail>
        createSession: (input: AgentSessionInput) => Promise<AgentSession>
        renameSession: (id: string, title: string) => Promise<AgentSession>
        deleteSession: (id: string) => Promise<void>
        listMessages: (id: string) => Promise<AgentMessage[]>
        chat: (request: AgentChatRequest) => Promise<AgentChatResponse>
        setLlmConfig: (id: string, llmConfigId: string | undefined) => Promise<AgentSession>
      }
      apiTokens: {
        list: () => Promise<ApiTokenView[]>
        create: (input: ApiTokenInput) => Promise<ApiToken>
        revoke: (id: string) => Promise<void>
        getApiBase: () => Promise<{ port: number }>
      }
      restApi: {
        call: (request: {
          method?: string
          path: string
          body?: unknown
          token?: string
        }) => Promise<RestApiResponse>
      }
      fs: {
        exists: (path: string) => Promise<boolean>
      }
    }
  }
}

export {}

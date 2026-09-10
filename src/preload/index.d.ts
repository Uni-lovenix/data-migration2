import type {
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
  LLMConfig,
  LLMConfigInput,
  MigrationTemplate,
  MigrationTask,
  PostgresConnectionTestResult,
  PostgresBatchExportRequest,
  PostgresBatchMigrationResult,
  PostgresCountRowsRequest,
  PostgresExportRequest,
  PostgresImportRequest,
  PostgresMigrationResult,
  PostgresTable,
  UpdateLLMConfigInput,
  UpdateTemplateInput
} from '../shared/types'

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
      }
    }
  }
}

export {}

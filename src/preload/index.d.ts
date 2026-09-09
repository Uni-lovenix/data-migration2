import type {
  AppInfo,
  ConnectionConfig,
  ConnectionInput,
  CreateMigrationTaskInput,
  ElasticsearchConnectionTestResult,
  ElasticsearchExportRequest,
  ElasticsearchImportRequest,
  ElasticsearchIndex,
  ElasticsearchMigrationResult,
  MigrationTask,
  PostgresConnectionTestResult,
  PostgresBatchExportRequest,
  PostgresBatchMigrationResult,
  PostgresCountRowsRequest,
  PostgresExportRequest,
  PostgresImportRequest,
  PostgresMigrationResult,
  PostgresTable
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
    }
  }
}

export {}

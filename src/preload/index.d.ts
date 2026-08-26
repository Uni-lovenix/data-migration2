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
        test: (connectionId: string) => Promise<PostgresConnectionTestResult>
        tables: (connectionId: string) => Promise<PostgresTable[]>
        export: (request: PostgresExportRequest) => Promise<PostgresMigrationResult>
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
        chooseImportFile: () => Promise<string | null>
      }
    }
  }
}

export {}

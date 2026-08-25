import type {
  AppInfo,
  ConnectionConfig,
  ConnectionInput,
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
      dialog: {
        chooseExportFile: (suggestedName: string) => Promise<string | null>
        chooseImportFile: () => Promise<string | null>
      }
    }
  }
}

export {}

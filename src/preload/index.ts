import { contextBridge, ipcRenderer } from 'electron'

import { IPC_CHANNELS } from '../shared/ipc'
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

const api = {
  app: {
    getInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC_CHANNELS.app.getInfo)
  },
  connections: {
    list: (): Promise<ConnectionConfig[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.connections.list),
    create: (input: ConnectionInput): Promise<ConnectionConfig> =>
      ipcRenderer.invoke(IPC_CHANNELS.connections.create, input),
    update: (id: string, input: ConnectionInput): Promise<ConnectionConfig> =>
      ipcRenderer.invoke(IPC_CHANNELS.connections.update, id, input),
    delete: (id: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.connections.delete, id)
  },
  postgres: {
    test: (connectionId: string): Promise<PostgresConnectionTestResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.postgres.test, connectionId),
    tables: (connectionId: string): Promise<PostgresTable[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.postgres.tables, connectionId),
    export: (request: PostgresExportRequest): Promise<PostgresMigrationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.postgres.export, request),
    import: (request: PostgresImportRequest): Promise<PostgresMigrationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.postgres.import, request)
  },
  dialog: {
    chooseExportFile: (suggestedName: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.dialog.chooseExportFile, suggestedName),
    chooseImportFile: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.dialog.chooseImportFile)
  }
}

contextBridge.exposeInMainWorld('api', api)

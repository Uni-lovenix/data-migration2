import { contextBridge, ipcRenderer } from 'electron'

import { IPC_CHANNELS } from '../shared/ipc'
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
  LLMChatRequest,
  LLMChatResponse,
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
    test: (
      connectionId: string,
      database?: string
    ): Promise<PostgresConnectionTestResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.postgres.test, connectionId, database),
    databases: (connectionId: string): Promise<string[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.postgres.databases, connectionId),
    tables: (connectionId: string, database?: string): Promise<PostgresTable[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.postgres.tables, connectionId, database),
    countRows: (request: PostgresCountRowsRequest): Promise<number> =>
      ipcRenderer.invoke(IPC_CHANNELS.postgres.countRows, request),
    export: (request: PostgresExportRequest): Promise<PostgresMigrationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.postgres.export, request),
    exportTables: (
      request: PostgresBatchExportRequest
    ): Promise<PostgresBatchMigrationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.postgres.exportTables, request),
    import: (request: PostgresImportRequest): Promise<PostgresMigrationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.postgres.import, request)
  },
  elasticsearch: {
    test: (connectionId: string): Promise<ElasticsearchConnectionTestResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.elasticsearch.test, connectionId),
    indices: (connectionId: string): Promise<ElasticsearchIndex[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.elasticsearch.indices, connectionId),
    export: (request: ElasticsearchExportRequest): Promise<ElasticsearchMigrationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.elasticsearch.export, request),
    import: (request: ElasticsearchImportRequest): Promise<ElasticsearchMigrationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.elasticsearch.import, request)
  },
  tasks: {
    list: (): Promise<MigrationTask[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.tasks.list),
    create: (input: CreateMigrationTaskInput): Promise<MigrationTask> =>
      ipcRenderer.invoke(IPC_CHANNELS.tasks.create, input),
    cancel: (id: string): Promise<MigrationTask> =>
      ipcRenderer.invoke(IPC_CHANNELS.tasks.cancel, id),
    resume: (id: string): Promise<MigrationTask> =>
      ipcRenderer.invoke(IPC_CHANNELS.tasks.resume, id),
    onChanged: (callback: (task: MigrationTask) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, task: MigrationTask): void => {
        callback(task)
      }
      ipcRenderer.on(IPC_CHANNELS.tasks.changed, listener)
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.tasks.changed, listener)
      }
    }
  },
  dialog: {
    chooseExportFile: (suggestedName: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.dialog.chooseExportFile, suggestedName),
    chooseExportDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.dialog.chooseExportDirectory),
    chooseImportFile: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.dialog.chooseImportFile)
  },
  templates: {
    list: (): Promise<MigrationTemplate[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.templates.list),
    get: (id: string): Promise<MigrationTemplate> =>
      ipcRenderer.invoke(IPC_CHANNELS.templates.get, id),
    create: (input: CreateTemplateInput): Promise<MigrationTemplate> =>
      ipcRenderer.invoke(IPC_CHANNELS.templates.create, input),
    update: (id: string, input: UpdateTemplateInput): Promise<MigrationTemplate> =>
      ipcRenderer.invoke(IPC_CHANNELS.templates.update, id, input),
    delete: (id: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.templates.delete, id),
    execute: (id: string, vars?: Record<string, string>): Promise<{ taskId: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.templates.execute, id, vars),
    executeMany: (
      requests: Array<{ id: string; vars?: Record<string, string> }>
    ): Promise<Array<{ taskId: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.templates.executeMany, requests)
  },
  llm: {
    list: (): Promise<LLMConfig[]> => ipcRenderer.invoke(IPC_CHANNELS.llm.list),
    get: (id: string): Promise<LLMConfig> => ipcRenderer.invoke(IPC_CHANNELS.llm.get, id),
    create: (input: LLMConfigInput): Promise<LLMConfig> =>
      ipcRenderer.invoke(IPC_CHANNELS.llm.create, input),
    update: (id: string, input: UpdateLLMConfigInput): Promise<LLMConfig> =>
      ipcRenderer.invoke(IPC_CHANNELS.llm.update, id, input),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.llm.delete, id),
    chat: (id: string, request: LLMChatRequest): Promise<LLMChatResponse> =>
      ipcRenderer.invoke(IPC_CHANNELS.llm.chat, id, request)
  }
}

contextBridge.exposeInMainWorld('api', api)

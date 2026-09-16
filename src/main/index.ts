import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'

import { ApiServer } from './api-server'

import { IPC_CHANNELS } from '../shared/ipc'
import type {
  AgentChatRequest,
  AgentSessionInput,
  ApiTokenInput,
  LLMChatRequest,
  LLMChatResponse,
  LLMConfigInput,
  UpdateLLMConfigInput
} from '../shared/types'
import {
  validateCreateMigrationTaskInput,
  validateElasticsearchExportRequest,
  validateElasticsearchImportRequest,
  validateMySQLBatchExportRequest,
  validateMySQLCountRowsRequest,
  validateMySQLExportRequest,
  validateMySQLImportRequest,
  validatePostgresBatchExportRequest,
  validatePostgresCountRowsRequest,
  validatePostgresExportRequest,
  validatePostgresImportRequest,
  validateHiveCountRowsRequest,
  validateHiveExportRequest,
  validateHiveImportRequest,
  validateNeo4jCountNodesRequest,
  validateNeo4jCountRelationshipsRequest,
  validateNeo4jExportRequest,
  validateSQLiteBatchExportRequest,
  validateSQLiteCountRowsRequest,
  validateSQLiteExportRequest
} from '../shared/validation'
import { AgentService } from './agent-service'
import { AgentSessionStore } from './agent-session-store'
import { ApiTokensStore } from './api-tokens-store'
import { ConnectionStore } from './connection-store'
import { ElasticsearchService } from './elasticsearch-service'
import { GoElasticsearchService } from './go-elasticsearch-service'
import { HiveService } from './hive-service'
import { LLMStore } from './llm-store'
import { LogRouter } from './log-router'
import { StructuredLogger } from './logger'
import { MySQLService } from './mysql-service'
import { Neo4jService } from './neo4j-service'
import { PostgresService } from './postgres-service'
import { SQLiteService } from './sqlite-service'
import { TaskManager } from './task-manager'
import { TaskStore } from './task-store'
import { TemplateStore } from './template-store'
import { buildStepDescriptors, resolveTaskInput } from './template-utils'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f4f6f8',
    title: 'DataMigrator',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function optionalDatabaseName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined
  }
  return value.trim()
}

// 模块级可变引用，供 apiTokens CRUD handler 与 apiServer 共享
let activeApiServer: ApiServer | null = null
function getActiveApiServer(): ApiServer | null {
  return activeApiServer
}

function registerIpcHandlers(
  store: ConnectionStore,
  postgres: PostgresService,
  elasticsearch: ElasticsearchService,
  mysql: MySQLService,
  sqlite: SQLiteService,
  hive: HiveService,
  neo4j: Neo4jService,
  goElasticsearch: GoElasticsearchService,
  taskManager: TaskManager,
  templateStore: TemplateStore,
  llmStore: LLMStore,
  agentService: AgentService,
  apiTokensStore: ApiTokensStore,
  apiPort: number
): void {
  ipcMain.handle(IPC_CHANNELS.app.getInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    userDataPath: app.getPath('userData')
  }))

  ipcMain.handle(IPC_CHANNELS.connections.list, () => store.list())
  ipcMain.handle(IPC_CHANNELS.connections.create, (_event, input: unknown) => {
    return store.create(input as Parameters<typeof store.create>[0])
  })
  ipcMain.handle(IPC_CHANNELS.connections.update, (_event, id: unknown, input: unknown) => {
    if (typeof id !== 'string') {
      throw new Error('连接 ID 必须是字符串')
    }
    return store.update(id, input as Parameters<typeof store.update>[1])
  })
  ipcMain.handle(IPC_CHANNELS.connections.delete, (_event, id: unknown) => {
    if (typeof id !== 'string') {
      throw new Error('连接 ID 必须是字符串')
    }
    return store.delete(id)
  })

  ipcMain.handle(
    IPC_CHANNELS.postgres.test,
    async (_event, connectionId: unknown, database: unknown) => {
      if (typeof connectionId !== 'string') {
        throw new Error('连接 ID 必须是字符串')
      }
      const connection = await store.get(connectionId)
      return postgres.testConnection(connection, optionalDatabaseName(database))
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.postgres.databases,
    async (_event, connectionId: unknown) => {
      if (typeof connectionId !== 'string') {
        throw new Error('连接 ID 必须是字符串')
      }
      const connection = await store.get(connectionId)
      return postgres.listDatabases(connection)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.postgres.tables,
    async (_event, connectionId: unknown, database: unknown) => {
      if (typeof connectionId !== 'string') {
        throw new Error('连接 ID 必须是字符串')
      }
      const connection = await store.get(connectionId)
      return postgres.listTables(connection, optionalDatabaseName(database))
    }
  )

  ipcMain.handle(IPC_CHANNELS.postgres.countRows, async (_event, input: unknown) => {
    const result = validatePostgresCountRowsRequest(input)
    if (!result.ok) {
      throw new Error(result.errors.join('；'))
    }
    const connection = await store.get(result.value.connectionId)
    return postgres.countRows(connection, result.value)
  })

  ipcMain.handle(IPC_CHANNELS.postgres.export, async (_event, input: unknown) => {
    const result = validatePostgresExportRequest(input)
    if (!result.ok) {
      throw new Error(result.errors.join('；'))
    }
    const connection = await store.get(result.value.connectionId)
    return postgres.exportTable(connection, result.value)
  })

  ipcMain.handle(IPC_CHANNELS.postgres.exportTables, async (_event, input: unknown) => {
    const result = validatePostgresBatchExportRequest(input)
    if (!result.ok) {
      throw new Error(result.errors.join('；'))
    }
    const connection = await store.get(result.value.connectionId)
    return postgres.exportTables(connection, result.value)
  })

  ipcMain.handle(IPC_CHANNELS.postgres.import, async (_event, input: unknown) => {
    const result = validatePostgresImportRequest(input)
    if (!result.ok) {
      throw new Error(result.errors.join('；'))
    }
    const connection = await store.get(result.value.connectionId)
    return postgres.importJsonl(connection, result.value)
  })

  ipcMain.handle(IPC_CHANNELS.elasticsearch.test, async (_event, connectionId: unknown) => {
    if (typeof connectionId !== 'string') {
      throw new Error('连接 ID 必须是字符串')
    }
    const connection = await store.get(connectionId)
    return elasticsearch.testConnection(connection)
  })

  ipcMain.handle(IPC_CHANNELS.elasticsearch.indices, async (_event, connectionId: unknown) => {
    if (typeof connectionId !== 'string') {
      throw new Error('连接 ID 必须是字符串')
    }
    const connection = await store.get(connectionId)
    return elasticsearch.listIndices(connection)
  })

  ipcMain.handle(IPC_CHANNELS.elasticsearch.export, async (_event, input: unknown) => {
    const result = validateElasticsearchExportRequest(input)
    if (!result.ok) {
      throw new Error(result.errors.join('；'))
    }
    const connection = await store.get(result.value.connectionId)
    return goElasticsearch.exportIndex(connection, result.value)
  })

  ipcMain.handle(IPC_CHANNELS.elasticsearch.import, async (_event, input: unknown) => {
    const result = validateElasticsearchImportRequest(input)
    if (!result.ok) {
      throw new Error(result.errors.join('；'))
    }
    const connection = await store.get(result.value.connectionId)
    return goElasticsearch.importJsonl(connection, result.value)
  })

  ipcMain.handle(
    IPC_CHANNELS.mysql.test,
    async (_event, connectionId: unknown, database: unknown) => {
      if (typeof connectionId !== 'string') {
        throw new Error('连接 ID 必须是字符串')
      }
      const connection = await store.get(connectionId)
      return mysql.testConnection(connection, optionalDatabaseName(database))
    }
  )

  ipcMain.handle(IPC_CHANNELS.mysql.databases, async (_event, connectionId: unknown) => {
    if (typeof connectionId !== 'string') {
      throw new Error('连接 ID 必须是字符串')
    }
    const connection = await store.get(connectionId)
    return mysql.listDatabases(connection)
  })

  ipcMain.handle(
    IPC_CHANNELS.mysql.tables,
    async (_event, connectionId: unknown, database: unknown) => {
      if (typeof connectionId !== 'string') {
        throw new Error('连接 ID 必须是字符串')
      }
      const connection = await store.get(connectionId)
      return mysql.listTables(connection, optionalDatabaseName(database))
    }
  )

  ipcMain.handle(IPC_CHANNELS.mysql.countRows, async (_event, input: unknown) => {
    const result = validateMySQLCountRowsRequest(input)
    if (!result.ok) {
      throw new Error(result.errors.join('；'))
    }
    const connection = await store.get(result.value.connectionId)
    return mysql.countRows(connection, result.value)
  })

  ipcMain.handle(IPC_CHANNELS.mysql.export, async (_event, input: unknown) => {
    const result = validateMySQLExportRequest(input)
    if (!result.ok) {
      throw new Error(result.errors.join('；'))
    }
    const connection = await store.get(result.value.connectionId)
    return mysql.exportTable(connection, result.value)
  })

  ipcMain.handle(IPC_CHANNELS.mysql.exportTables, async (_event, input: unknown) => {
    const result = validateMySQLBatchExportRequest(input)
    if (!result.ok) {
      throw new Error(result.errors.join('；'))
    }
    const connection = await store.get(result.value.connectionId)
    return mysql.exportTables(connection, result.value)
  })

  ipcMain.handle(IPC_CHANNELS.mysql.import, async (_event, input: unknown) => {
    const result = validateMySQLImportRequest(input)
    if (!result.ok) {
      throw new Error(result.errors.join('；'))
    }
    const connection = await store.get(result.value.connectionId)
    return mysql.importJsonl(connection, result.value)
  })

  ipcMain.handle(
    IPC_CHANNELS.sqlite.test,
    async (_event, connectionId: unknown) => {
      if (typeof connectionId !== 'string') {
        throw new Error('连接 ID 必须是字符串')
      }
      const connection = await store.get(connectionId)
      return sqlite.testConnection(connection)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.sqlite.tables,
    async (_event, connectionId: unknown) => {
      if (typeof connectionId !== 'string') {
        throw new Error('连接 ID 必须是字符串')
      }
      const connection = await store.get(connectionId)
      return sqlite.listTables(connection)
    }
  )

  ipcMain.handle(IPC_CHANNELS.sqlite.countRows, async (_event, input: unknown) => {
    const result = validateSQLiteCountRowsRequest(input)
    if (!result.ok) {
      throw new Error(result.errors.join('；'))
    }
    const connection = await store.get(result.value.connectionId)
    return sqlite.countRows(connection, result.value)
  })

  ipcMain.handle(IPC_CHANNELS.sqlite.export, async (_event, input: unknown) => {
    const result = validateSQLiteExportRequest(input)
    if (!result.ok) {
      throw new Error(result.errors.join('；'))
    }
    const connection = await store.get(result.value.connectionId)
    return sqlite.exportTable(connection, result.value)
  })

  ipcMain.handle(IPC_CHANNELS.sqlite.exportTables, async (_event, input: unknown) => {
    const result = validateSQLiteBatchExportRequest(input)
    if (!result.ok) {
      throw new Error(result.errors.join('；'))
    }
    const connection = await store.get(result.value.connectionId)
    return sqlite.exportTables(connection, result.value)
  })

  ipcMain.handle(IPC_CHANNELS.hive.test, async (_event, connectionId: unknown) => {
    if (typeof connectionId !== 'string') {
      throw new Error('连接 ID 必须是字符串')
    }
    const connection = await store.get(connectionId)
    return hive.testConnection(connection)
  })

  ipcMain.handle(IPC_CHANNELS.hive.databases, async (_event, connectionId: unknown) => {
    if (typeof connectionId !== 'string') {
      throw new Error('连接 ID 必须是字符串')
    }
    const connection = await store.get(connectionId)
    return hive.listDatabases(connection)
  })

  ipcMain.handle(
    IPC_CHANNELS.hive.tables,
    async (_event, connectionId: unknown, database: unknown) => {
      if (typeof connectionId !== 'string') {
        throw new Error('连接 ID 必须是字符串')
      }
      const connection = await store.get(connectionId)
      return hive.listTables(connection, optionalDatabaseName(database) ?? '')
    }
  )

  ipcMain.handle(IPC_CHANNELS.hive.countRows, async (_event, input: unknown) => {
    const result = validateHiveCountRowsRequest(input)
    if (!result.ok) {
      throw new Error(result.errors.join('；'))
    }
    const connection = await store.get(result.value.connectionId)
    return hive.countRows(connection, result.value)
  })

  ipcMain.handle(IPC_CHANNELS.hive.export, async (_event, input: unknown) => {
    const result = validateHiveExportRequest(input)
    if (!result.ok) {
      throw new Error(result.errors.join('；'))
    }
    const connection = await store.get(result.value.connectionId)
    return hive.exportTable(connection, result.value)
  })

  ipcMain.handle(IPC_CHANNELS.hive.import, async (_event, input: unknown) => {
    const result = validateHiveImportRequest(input)
    if (!result.ok) {
      throw new Error(result.errors.join('；'))
    }
    const connection = await store.get(result.value.connectionId)
    return hive.importJsonl(connection, result.value)
  })

  ipcMain.handle(IPC_CHANNELS.neo4j.test, async (_event, connectionId: unknown) => {
    if (typeof connectionId !== 'string') {
      throw new Error('连接 ID 必须是字符串')
    }
    const connection = await store.get(connectionId)
    return neo4j.testConnection(connection)
  })

  ipcMain.handle(IPC_CHANNELS.neo4j.labels, async (_event, connectionId: unknown) => {
    if (typeof connectionId !== 'string') {
      throw new Error('连接 ID 必须是字符串')
    }
    const connection = await store.get(connectionId)
    return neo4j.listLabels(connection)
  })

  ipcMain.handle(
    IPC_CHANNELS.neo4j.relationshipTypes,
    async (_event, connectionId: unknown) => {
      if (typeof connectionId !== 'string') {
        throw new Error('连接 ID 必须是字符串')
      }
      const connection = await store.get(connectionId)
      return neo4j.listRelationshipTypes(connection)
    }
  )

  ipcMain.handle(IPC_CHANNELS.neo4j.countNodes, async (_event, input: unknown) => {
    const result = validateNeo4jCountNodesRequest(input)
    if (!result.ok) {
      throw new Error(result.errors.join('；'))
    }
    const connection = await store.get(result.value.connectionId)
    return neo4j.countNodes(connection, result.value)
  })

  ipcMain.handle(
    IPC_CHANNELS.neo4j.countRelationships,
    async (_event, input: unknown) => {
      const result = validateNeo4jCountRelationshipsRequest(input)
      if (!result.ok) {
        throw new Error(result.errors.join('；'))
      }
      const connection = await store.get(result.value.connectionId)
      return neo4j.countRelationships(connection, result.value)
    }
  )

  ipcMain.handle(IPC_CHANNELS.neo4j.export, async (_event, input: unknown) => {
    const result = validateNeo4jExportRequest(input)
    if (!result.ok) {
      throw new Error(result.errors.join('；'))
    }
    const connection = await store.get(result.value.connectionId)
    return neo4j.exportTable(connection, result.value)
  })

  ipcMain.handle(IPC_CHANNELS.tasks.list, () => taskManager.list())

  ipcMain.handle(IPC_CHANNELS.tasks.create, (_event, input: unknown) => {
    const result = validateCreateMigrationTaskInput(input)
    if (!result.ok) {
      throw new Error(result.errors.join('；'))
    }
    return taskManager.create(result.value)
  })

  ipcMain.handle(IPC_CHANNELS.tasks.cancel, (_event, id: unknown) => {
    if (typeof id !== 'string') {
      throw new Error('任务 ID 必须是字符串')
    }
    return taskManager.cancel(id)
  })

  ipcMain.handle(IPC_CHANNELS.tasks.resume, (_event, id: unknown) => {
    if (typeof id !== 'string') {
      throw new Error('任务 ID 必须是字符串')
    }
    return taskManager.resume(id)
  })

  ipcMain.handle(
    IPC_CHANNELS.dialog.chooseExportFile,
    async (_event, suggestedName: unknown) => {
      const options: Electron.SaveDialogOptions = {
        title: '选择导出文件',
        defaultPath:
          typeof suggestedName === 'string' && suggestedName.trim().length > 0
            ? suggestedName.trim()
            : 'postgres-export.jsonl',
        filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }]
      }
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options)
      return result.canceled || !result.filePath ? null : result.filePath
    }
  )

  ipcMain.handle(IPC_CHANNELS.dialog.chooseImportFile, async () => {
    const options: Electron.OpenDialogOptions = {
      title: '选择导入文件',
      properties: ['openFile'],
      filters: [
        { name: 'JSON Lines', extensions: ['jsonl', 'json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.dialog.chooseSQLiteFile, async () => {
    const options: Electron.OpenDialogOptions = {
      title: '选择 SQLite 数据库',
      properties: ['openFile'],
      filters: [
        { name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.dialog.chooseExportDirectory, async () => {
    const options: Electron.OpenDialogOptions = {
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.fs.exists, async (_event, path: unknown) => {
    if (typeof path !== 'string' || path.length === 0) {
      return false
    }
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  })

  // Template handlers
  ipcMain.handle(IPC_CHANNELS.templates.list, () => templateStore.list())
  ipcMain.handle(IPC_CHANNELS.templates.get, (_event, id: unknown) => {
    if (typeof id !== 'string') {
      throw new Error('模板 ID 必须是字符串')
    }
    return templateStore.get(id)
  })
  ipcMain.handle(IPC_CHANNELS.templates.create, (_event, input: unknown) => {
    return templateStore.create(input as Parameters<typeof templateStore.create>[0])
  })
  ipcMain.handle(IPC_CHANNELS.templates.update, (_event, id: unknown, input: unknown) => {
    if (typeof id !== 'string') {
      throw new Error('模板 ID 必须是字符串')
    }
    return templateStore.update(id, input as Parameters<typeof templateStore.update>[1])
  })
  ipcMain.handle(IPC_CHANNELS.templates.delete, (_event, id: unknown) => {
    if (typeof id !== 'string') {
      throw new Error('模板 ID 必须是字符串')
    }
    return templateStore.delete(id)
  })
  ipcMain.handle(IPC_CHANNELS.templates.execute, (_event, id: unknown, vars: unknown) => {
    if (typeof id !== 'string') {
      throw new Error('模板 ID 必须是字符串')
    }
    return executeTemplate(templateStore, store, taskManager, id, (vars as Record<string, string>) ?? {})
  })
  ipcMain.handle(IPC_CHANNELS.templates.executeMany, (_event, requests: unknown) => {
    if (!Array.isArray(requests)) {
      throw new Error('请求必须是数组')
    }
    return Promise.all(
      (requests as { id: string; vars?: Record<string, string> }[]).map((r) =>
        executeTemplate(templateStore, store, taskManager, r.id, r.vars ?? {})
      )
    )
  })

  // LLM handlers
  ipcMain.handle(IPC_CHANNELS.llm.list, () => llmStore.list())
  ipcMain.handle(IPC_CHANNELS.llm.get, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('LLM 配置 ID 必须是字符串')
    return llmStore.get(id)
  })
  ipcMain.handle(IPC_CHANNELS.llm.create, (_event, input: unknown) => {
    return llmStore.create(input as LLMConfigInput)
  })
  ipcMain.handle(IPC_CHANNELS.llm.update, (_event, id: unknown, input: unknown) => {
    if (typeof id !== 'string') throw new Error('LLM 配置 ID 必须是字符串')
    return llmStore.update(id, input as UpdateLLMConfigInput)
  })
  ipcMain.handle(IPC_CHANNELS.llm.delete, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('LLM 配置 ID 必须是字符串')
    return llmStore.delete(id)
  })
  ipcMain.handle(
    IPC_CHANNELS.llm.chat,
    async (_event, id: unknown, request: unknown): Promise<LLMChatResponse> => {
      if (typeof id !== 'string') throw new Error('LLM 配置 ID 必须是字符串')
      return chatWithLLM(llmStore, id, request as LLMChatRequest)
    }
  )

  // ---- Agent (function-calling chat) ----
  ipcMain.handle(IPC_CHANNELS.agent.listSessions, () => agentService.listSessions())
  ipcMain.handle(IPC_CHANNELS.agent.getSession, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('会话 ID 必须是字符串')
    return {
      session: agentService.getSession(id),
      messages: agentService.listMessages(id)
    }
  })
  ipcMain.handle(IPC_CHANNELS.agent.createSession, (_event, input: unknown) => {
    return agentService.createSession(input as AgentSessionInput)
  })
  ipcMain.handle(IPC_CHANNELS.agent.renameSession, (_event, id: unknown, title: unknown) => {
    if (typeof id !== 'string') throw new Error('会话 ID 必须是字符串')
    if (typeof title !== 'string') throw new Error('会话标题必须是字符串')
    return agentService.renameSession(id, title)
  })
  ipcMain.handle(IPC_CHANNELS.agent.deleteSession, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('会话 ID 必须是字符串')
    agentService.deleteSession(id)
  })
  ipcMain.handle(IPC_CHANNELS.agent.listMessages, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('会话 ID 必须是字符串')
    return agentService.listMessages(id)
  })
  ipcMain.handle(IPC_CHANNELS.agent.chat, async (_event, request: unknown) => {
    const req = request as AgentChatRequest
    if (!req || typeof req.sessionId !== 'string' || typeof req.userMessage !== 'string') {
      throw new Error('请求格式错误：需要 sessionId 和 userMessage')
    }
    return agentService.chat(req)
  })

  // ---- API Tokens ----
  ipcMain.handle(IPC_CHANNELS.apiTokens.list, () => apiTokensStore.list())
  ipcMain.handle(IPC_CHANNELS.apiTokens.create, async (_event, input: unknown) => {
    const created = await apiTokensStore.create(input as ApiTokenInput)
    // 热更新 ApiServer token 列表
    getActiveApiServer()?.updateTokens(await apiTokensStore.loadRawTokens())
    return created
  })
  ipcMain.handle(IPC_CHANNELS.apiTokens.revoke, async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Token ID 必须是字符串')
    await apiTokensStore.revoke(id)
    getActiveApiServer()?.updateTokens(await apiTokensStore.loadRawTokens())
  })
  ipcMain.handle(IPC_CHANNELS.apiTokens.apiBase, () => ({ port: apiPort }))

  // ---- REST API client (used by Token-In 页面) ----
  ipcMain.handle(
    IPC_CHANNELS.restApi.call,
    async (_event, request: unknown) => {
      const req = request as {
        method?: string
        path?: string
        body?: unknown
        token?: string
      }
      if (typeof req?.path !== 'string' || req.path.length === 0) {
        throw new Error('path 必须是非空字符串')
      }
      const method = (req.method ?? 'GET').toUpperCase()
      const url = `http://127.0.0.1:${apiPort}${req.path.startsWith('/') ? req.path : `/${req.path}`}`
      const headers: Record<string, string> = {}
      if (req.body !== undefined) headers['Content-Type'] = 'application/json'
      if (typeof req.token === 'string' && req.token.length > 0) {
        headers['Authorization'] = `Bearer ${req.token}`
      }
      const init: RequestInit = { method, headers }
      if (req.body !== undefined) {
        init.body = JSON.stringify(req.body)
      }
      const response = await fetch(url, init)
      const text = await response.text()
      let data: unknown = null
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          data = text
        }
      }
      return { ok: response.ok, status: response.status, data }
    }
  )

}


// (template variable substitution now lives in ./template-utils.ts)

// Call LLM provider API based on config
async function chatWithLLM(
  llmStore: LLMStore,
  id: string,
  request: LLMChatRequest
): Promise<LLMChatResponse> {
  const config = llmStore.get(id)
  const apiKey = llmStore.getDecryptedApiKey(id)
  if (!apiKey) throw new Error('LLM API key not available')

  const model = request.model ?? config.model
  let url: string
  let headers: Record<string, string> = {}
  let body: object

  if (config.provider === 'ollama') {
    const base = config.apiBase ?? 'http://localhost:11434'
    url = `${base}/api/chat`
    headers = { 'Content-Type': 'application/json' }
    body = { model, messages: request.messages, stream: false }
  } else if (config.provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages'
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }
    body = {
      model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? 4096
    }
  } else {
    // openai
    const base = config.apiBase ?? 'https://api.openai.com'
    url = `${base}/v1/chat/completions`
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
    body = { model, messages: request.messages, max_tokens: request.maxTokens }
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
    if (response.status === 401) {
      throw new Error(`LLM 认证失败（401）。请检查 API Key 是否有效。Provider: ${config.provider}`)
    }
    if (response.status === 403) {
      throw new Error(`LLM 访问被拒绝（403）。请检查 API Key 权限或配额。Provider: ${config.provider}`)
    }
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`LLM API error ${response.status}: ${text}`)
    }
    return parseLLMResponse(response, config.provider)
  } catch (err: any) {
    // Re-throw network errors that are not 401/403 (already handled above)
    throw err
  }
}

async function parseLLMResponse(response: Response, provider: string): Promise<LLMChatResponse> {
  const data = (await response.json()) as {
    message?: { role: string; content: string }
    choices?: Array<{ message: { role: string; content: string } }>
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  }

  let message: { role: 'assistant'; content: string }
  if (provider === 'anthropic') {
    message = { role: 'assistant', content: (data as { content?: Array<{ type: string; text?: string }> }).content?.[0]?.text ?? '' }
  } else {
    const msg = data.message ?? data.choices?.[0]?.message
    message = { role: 'assistant', content: msg?.content ?? '' }
  }
  const usage = data.usage
  return {
    message,
    usage: usage
      ? {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens
        }
      : undefined
  }
}

// Resolve a template by substituting variables and creating one migration task
// per step. Multi-step templates queue tasks via TaskManager's FIFO worker,
// so they execute sequentially in the order they were created.
async function executeTemplate(
  templateStore: TemplateStore,
  store: ConnectionStore,
  taskManager: TaskManager,
  id: string,
  vars: Record<string, string>
): Promise<{ taskId: string; taskIds: string[] }> {
  const tmpl = templateStore.get(id)
  const descriptors = buildStepDescriptors(tmpl, vars)

  const taskIds: string[] = []
  for (const step of descriptors) {
    const srcConnection = await store.getByName(step.connectionName)
    if (!srcConnection) {
      throw new Error(`源连接不存在：${step.connectionName}`)
    }
    let dstConnectionId: string | undefined
    if (step.dstConnectionName) {
      const dstConnection = await store.getByName(step.dstConnectionName)
      if (!dstConnection) {
        throw new Error(`目标连接不存在：${step.dstConnectionName}`)
      }
      dstConnectionId = dstConnection.id
    }

    const taskInput = resolveTaskInput({
      engine: step.engine,
      action: step.action,
      connectionId: srcConnection.id,
      dstConnectionId,
      configJson: step.configJson,
      vars: step.vars
    })
    const task = taskManager.create(taskInput)
    taskIds.push(task.id)
  }

  return { taskId: taskIds[0]!, taskIds }
}

void app.whenReady().then(async () => {
  const store = new ConnectionStore(join(app.getPath('userData'), 'connections.json'))
  const taskStore = new TaskStore(join(app.getPath('userData'), 'tasks.db'))
  const templateStore = new TemplateStore(join(app.getPath('userData'), 'templates.db'))
  const llmStore = new LLMStore(join(app.getPath('userData'), 'llm-configs.db'))
  const agentSessionStore = new AgentSessionStore(join(app.getPath('userData'), 'agent-sessions.db'))
  const apiTokensStore = new ApiTokensStore(join(app.getPath('userData'), 'api-tokens.json'))
  const logPath = join(app.getPath('userData'), 'logs', 'migration.log')
  const logger = new StructuredLogger(logPath)
  await taskStore.initialize()
  await templateStore.initialize()
  await llmStore.initialize()
  await agentSessionStore.initialize()
  await apiTokensStore.list()
  const postgres = new PostgresService()
  const elasticsearch = new ElasticsearchService()
  const mysql = new MySQLService()
  const sqlite = new SQLiteService()
  const hive = new HiveService()
  const neo4j = new Neo4jService()
  const goElasticsearch = new GoElasticsearchService()
  const taskManager = new TaskManager({
    store: taskStore,
    logger,
    connections: store,
    postgres,
    mysql,
    sqlite,
    hive,
    neo4j,
    elasticsearch: goElasticsearch,
    onChanged: (task) => {
      mainWindow?.webContents.send(IPC_CHANNELS.tasks.changed, task)
    }
  })
  await taskManager.recoverInterrupted()
  const agentService = new AgentService({
    sessions: agentSessionStore,
    llmStore,
    connections: store,
    templates: templateStore,
    taskManager
  })
  const apiPort = 3847
  registerIpcHandlers(store, postgres, elasticsearch, mysql, sqlite, hive, neo4j, goElasticsearch, taskManager, templateStore, llmStore, agentService, apiTokensStore, apiPort)

  // Start LogRouter — routes task logs to LLM for analysis
  const logRouter = new LogRouter({
    logPath,
    intervalMs: 10000,
    configProvider: () => llmStore.list().find((c) => c.enabled),
    onBatch: async (batch) => {
      const config = llmStore.list().find((c) => c.enabled)
      if (!config) return
      const apiKey = llmStore.getDecryptedApiKey(config.id)
      if (!apiKey) return
      const base = config.apiBase ?? (config.provider === 'ollama' ? 'http://localhost:11434' : config.provider === 'openai' ? 'https://api.openai.com' : 'https://api.anthropic.com')
      const url = config.provider === 'anthropic' ? `${base}/v1/messages` : `${base}/v1/chat/completions`
      const messages = [
        { role: 'system' as const, content: 'You are a data migration assistant. Analyze the following log batch from a migration task and report any errors, warnings, or notable patterns.' },
        { role: 'user' as const, content: `Log batch:\n${batch.lines.join('\n')}` }
      ]
      let headers: Record<string, string> = {}
      let body: object = {}
      if (config.provider === 'anthropic') {
        headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
        body = { model: config.model, messages, max_tokens: 256 }
      } else if (config.provider === 'ollama') {
        headers = { 'Content-Type': 'application/json' }
        body = { model: config.model, messages, stream: false }
      } else {
        headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
        body = { model: config.model, messages }
      }
      try {
        await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
      } catch {
        // silently ignore LLM routing failures
      }
    }
  })
  logRouter.start()

  // Start REST API server with token authentication
  const initialTokens = await apiTokensStore.loadRawTokens()
  const apiServer = new ApiServer({
    port: apiPort,
    tokens: [], // 通过 updateTokens 注入真实列表
    onLLMChat: async (body: unknown) => {
      const { id, messages, model, maxTokens } = body as {
        id: string
        messages: Array<{ role: 'assistant' | 'user' | 'system'; content: string }>
        model?: string
        maxTokens?: number
      }
      return chatWithLLM(llmStore, id, { messages, model, maxTokens })
    },
    onAgentChat: async (body: unknown) => {
      const req = body as AgentChatRequest
      if (!req || typeof req.sessionId !== 'string' || typeof req.userMessage !== 'string') {
        throw new Error('请求格式错误：需要 sessionId 和 userMessage')
      }
      return agentService.chat(req)
    },
    onConnectionsList: async () => {
      const all = await store.list()
      return all.map((c) => ({ ...c, password: undefined }))
    },
    onConnectionsGet: async (id: string) => {
      const connection = await store.get(id)
      return { ...connection, password: undefined }
    },
    onTemplatesList: async () => templateStore.list(),
    onTemplateExecute: async (id: string, vars: Record<string, string> | undefined) => {
      return executeTemplate(templateStore, store, taskManager, id, vars ?? {})
    },
    onTasks: async () => taskManager.list(),
    onTaskGet: async (id: string) => taskManager.get(id),
    onTaskCancel: async (id: string) => taskManager.cancel(id),
    onTaskCreate: async (input: unknown) => {
      const validated = validateCreateMigrationTaskInput(input)
      if (!validated.ok) throw new Error(validated.errors.join('；'))
      return taskManager.create(validated.value)
    }
  })
  apiServer.updateTokens(initialTokens)
  await apiServer.start()
  // 把 server 引用注入到 registerIpcHandlers 闭包，使 token CRUD 时可同步刷新鉴权集合
  activeApiServer = apiServer

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

import { join } from 'node:path'

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'

import { ApiServer } from './api-server'

import { IPC_CHANNELS } from '../shared/ipc'
import type {
  LLMChatRequest,
  LLMChatResponse,
  LLMConfigInput,
  UpdateLLMConfigInput
} from '../shared/types'
import {
  validateCreateMigrationTaskInput,
  validateElasticsearchExportRequest,
  validateElasticsearchImportRequest,
  validatePostgresBatchExportRequest,
  validatePostgresCountRowsRequest,
  validatePostgresExportRequest,
  validatePostgresImportRequest
} from '../shared/validation'
import { ConnectionStore } from './connection-store'
import { ElasticsearchService } from './elasticsearch-service'
import { GoElasticsearchService } from './go-elasticsearch-service'
import { LLMStore } from './llm-store'
import { LogRouter } from './log-router'
import { StructuredLogger } from './logger'
import { PostgresService } from './postgres-service'
import { TaskManager } from './task-manager'
import { TaskStore } from './task-store'
import { TemplateStore } from './template-store'

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

function registerIpcHandlers(
  store: ConnectionStore,
  postgres: PostgresService,
  elasticsearch: ElasticsearchService,
  goElasticsearch: GoElasticsearchService,
  taskManager: TaskManager,
  templateStore: TemplateStore,
  llmStore: LLMStore
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
}

// Replace template variables in a string: "Hello {{NAME}}" + { NAME: "World" } => "Hello World"
function replaceVariables(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in vars ? (vars[key] ?? match) : match))
}

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

// Resolve a template by substituting variables and creating a migration task
async function executeTemplate(
  templateStore: TemplateStore,
  store: ConnectionStore,
  taskManager: TaskManager,
  id: string,
  vars: Record<string, string>
): Promise<{ taskId: string }> {
  const tmpl = templateStore.get(id)

  // Resolve src connection name → connectionId
  const srcConnection = await store.getByName(tmpl.connectionName)
  if (!srcConnection) {
    throw new Error(`源连接不存在：${tmpl.connectionName}`)
  }

  // Resolve dst connection name → connectionId (optional)
  let dstConnectionId: string | undefined
  if (tmpl.dstConnectionName) {
    const dstConnection = await store.getByName(tmpl.dstConnectionName)
    if (!dstConnection) {
      throw new Error(`目标连接不存在：${tmpl.dstConnectionName}`)
    }
    dstConnectionId = dstConnection.id
  }

  // Merge built-in vars
  const now = new Date()
  const builtInVars: Record<string, string> = {
    TODAY: now.toISOString().slice(0, 10),
    NOW: now.toTimeString().slice(0, 8),
    TIMESTAMP: String(Math.floor(now.getTime() / 1000))
  }
  const allVars = { ...builtInVars, ...vars }

  const resolvedConfigJson = replaceVariables(tmpl.configJson, allVars)
  const payload = JSON.parse(resolvedConfigJson)
  payload.connectionId = srcConnection.id
  if (dstConnectionId) {
    payload.dstConnectionId = dstConnectionId
  }

  const task = taskManager.create({
    type: payload.type ?? `${tmpl.engine}-${tmpl.action}`,
    payload
  })
  return { taskId: task.id }
}

void app.whenReady().then(async () => {
  const store = new ConnectionStore(join(app.getPath('userData'), 'connections.json'))
  const taskStore = new TaskStore(join(app.getPath('userData'), 'tasks.db'))
  const templateStore = new TemplateStore(join(app.getPath('userData'), 'templates.db'))
  const llmStore = new LLMStore(join(app.getPath('userData'), 'llm-configs.db'))
  const logPath = join(app.getPath('userData'), 'logs', 'migration.log')
  const logger = new StructuredLogger(logPath)
  await taskStore.initialize()
  await templateStore.initialize()
  await llmStore.initialize()
  const postgres = new PostgresService()
  const elasticsearch = new ElasticsearchService()
  const goElasticsearch = new GoElasticsearchService()
  const taskManager = new TaskManager({
    store: taskStore,
    logger,
    connections: store,
    postgres,
    elasticsearch: goElasticsearch,
    onChanged: (task) => {
      mainWindow?.webContents.send(IPC_CHANNELS.tasks.changed, task)
    }
  })
  await taskManager.recoverInterrupted()
  registerIpcHandlers(store, postgres, elasticsearch, goElasticsearch, taskManager, templateStore, llmStore)

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

  // Start REST API server (no auth token required for internal use)
  const apiServer = new ApiServer({
    port: 3847,
    tokens: [],
    onLLMChat: async (body: unknown) => {
      const { id, messages, model, maxTokens } = body as {
        id: string
        messages: Array<{ role: 'assistant' | 'user' | 'system'; content: string }>
        model?: string
        maxTokens?: number
      }
      return chatWithLLM(llmStore, id, { messages, model, maxTokens })
    }
  })
  await apiServer.start()

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

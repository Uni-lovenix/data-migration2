import { join } from 'node:path'

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'

import { IPC_CHANNELS } from '../shared/ipc'
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
import { StructuredLogger } from './logger'
import { PostgresService } from './postgres-service'
import { TaskManager } from './task-manager'
import { TaskStore } from './task-store'

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
  taskManager: TaskManager
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
}

void app.whenReady().then(async () => {
  const store = new ConnectionStore(join(app.getPath('userData'), 'connections.json'))
  const taskStore = new TaskStore(join(app.getPath('userData'), 'tasks.db'))
  const logger = new StructuredLogger(
    join(app.getPath('userData'), 'logs', 'migration.log')
  )
  await taskStore.initialize()
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
  registerIpcHandlers(store, postgres, elasticsearch, goElasticsearch, taskManager)
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

import { randomUUID } from 'node:crypto'

import type {
  ConnectionConfig,
  CreateMigrationTaskInput,
  ElasticsearchExportRequest,
  ElasticsearchImportRequest,
  HiveExportRequest,
  HiveImportRequest,
  MigrationTask,
  MySQLBatchExportRequest,
  MySQLExportRequest,
  MySQLImportRequest,
  PostgresBatchExportRequest,
  PostgresExportRequest,
  PostgresImportRequest,
  SQLiteBatchExportRequest,
  SQLiteExportRequest
} from '../shared/types'
import type { ConnectionStore } from './connection-store'
import type { ElasticsearchService } from './elasticsearch-service'
import type { StructuredLogger } from './logger'
import type { MySQLService } from './mysql-service'
import type { HiveService } from './hive-service'
import type { PostgresService } from './postgres-service'
import type { SQLiteService } from './sqlite-service'
import { TaskCancelledError } from './task-errors'
import type { TaskStore } from './task-store'

interface TaskManagerOptions {
  store: TaskStore
  logger: StructuredLogger
  connections: Pick<ConnectionStore, 'get'>
  postgres: Pick<
    PostgresService,
    'exportTable' | 'exportTables' | 'importJsonl'
  >
  elasticsearch: Pick<
    ElasticsearchService,
    'exportIndex' | 'importJsonl'
  >
  mysql: Pick<MySQLService, 'exportTable' | 'exportTables' | 'importJsonl'>
  sqlite: Pick<SQLiteService, 'exportTable' | 'exportTables'>
  hive: Pick<HiveService, 'exportTable' | 'importJsonl'>
  onChanged?: (task: MigrationTask) => void
}

export class TaskManager {
  private readonly store: TaskStore
  private readonly logger: StructuredLogger
  private readonly connections: Pick<ConnectionStore, 'get'>
  private readonly postgres: Pick<
    PostgresService,
    'exportTable' | 'exportTables' | 'importJsonl'
  >
  private readonly elasticsearch: Pick<
    ElasticsearchService,
    'exportIndex' | 'importJsonl'
  >
  private readonly mysql: Pick<MySQLService, 'exportTable' | 'exportTables' | 'importJsonl'>
  private readonly sqlite: Pick<SQLiteService, 'exportTable' | 'exportTables'>
  private readonly hive: Pick<HiveService, 'exportTable' | 'importJsonl'>
  private readonly onChanged?: (task: MigrationTask) => void
  private readonly queue: string[] = []
  private readonly cancelled = new Set<string>()
  private processing = false

  constructor(options: TaskManagerOptions) {
    this.store = options.store
    this.logger = options.logger
    this.connections = options.connections
    this.postgres = options.postgres
    this.elasticsearch = options.elasticsearch
    this.mysql = options.mysql
    this.sqlite = options.sqlite
    this.hive = options.hive
    this.onChanged = options.onChanged
  }

  async recoverInterrupted(): Promise<void> {
    const interrupted = this.store.list().filter(
      (task) => task.status === 'running' || task.status === 'queued'
    )
    for (const task of interrupted) {
      task.status = 'paused'
      task.finishedAt = new Date().toISOString()
      this.store.update(task)
      this.emit(task)
      this.logger.info('task-manager', 'task_interrupted_and_paused', {
        taskId: task.id,
        type: task.type
      })
    }
  }

  list(): MigrationTask[] {
    return this.store.list()
  }

  get(id: string): MigrationTask {
    return this.store.get(id)
  }

  create(input: CreateMigrationTaskInput): MigrationTask {
    const now = new Date().toISOString()
    const task: MigrationTask = {
      id: randomUUID(),
      type: input.type,
      status: 'queued',
      connectionId: input.payload.connectionId,
      payload: input.payload,
      progress: 0,
      createdAt: now
    }
    this.store.insert(task)
    this.queue.push(task.id)
    this.emit(task)
    this.logger.info('task-manager', 'task_queued', {
      taskId: task.id,
      type: task.type,
      connectionId: task.connectionId
    })
    void this.processNext()
    return task
  }

  cancel(id: string): MigrationTask {
    const task = this.store.get(id)
    if (task.status === 'queued' || task.status === 'paused') {
      task.status = 'canceled'
      task.finishedAt = new Date().toISOString()
      this.store.update(task)
      this.removeFromQueue(id)
      this.emit(task)
      this.logger.info('task-manager', 'task_canceled', { taskId: id })
      return task
    }
    if (task.status === 'running') {
      this.cancelled.add(id)
    }
    return task
  }

  resume(id: string): MigrationTask {
    const task = this.store.get(id)
    if (task.status !== 'canceled' && task.status !== 'failed' && task.status !== 'paused') {
      return task
    }
    task.status = 'queued'
    task.error = undefined
    task.finishedAt = undefined
    this.store.update(task)
    this.queue.push(task.id)
    this.emit(task)
    this.logger.info('task-manager', 'task_resumed', {
      taskId: id,
      type: task.type,
      progress: task.progress
    })
    void this.processNext()
    return task
  }

  private async processNext(): Promise<void> {
    if (this.processing) {
      return
    }
    this.processing = true
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift()
        if (!id) {
          continue
        }
        if (this.cancelled.has(id)) {
          this.cancelled.delete(id)
          const canceled = this.store.get(id)
          canceled.status = 'canceled'
          canceled.finishedAt = new Date().toISOString()
          this.store.update(canceled)
          this.emit(canceled)
          continue
        }

        const task = this.store.get(id)
        if (task.status !== 'queued') {
          continue
        }

        task.status = 'running'
        task.startedAt = new Date().toISOString()
        task.error = undefined
        this.store.update(task)
        this.emit(task)
        this.logger.info('task-manager', 'task_started', {
          taskId: task.id,
          type: task.type
        })

        try {
          const connection = await this.connections.get(task.connectionId)
          await this.runTask(task, connection)
          if (this.cancelled.has(task.id)) {
            throw new TaskCancelledError(task.id)
          }
          const latest = this.store.get(task.id)
          latest.status = 'completed'
          latest.finishedAt = new Date().toISOString()
          latest.error = undefined
          this.store.update(latest)
          this.emit(latest)
          this.logger.info('task-manager', 'task_completed', {
            taskId: task.id,
            type: task.type,
            progress: latest.progress
          })
        } catch (error) {
          const latest = this.store.get(task.id)
          if (error instanceof TaskCancelledError || this.cancelled.has(task.id)) {
            latest.status = 'canceled'
            latest.finishedAt = new Date().toISOString()
            this.store.update(latest)
            this.emit(latest)
            this.logger.warn('task-manager', 'task_canceled', {
              taskId: task.id,
              progress: latest.progress
            })
          } else {
            latest.status = 'failed'
            latest.error = errorMessage(error)
            latest.finishedAt = new Date().toISOString()
            this.store.update(latest)
            this.emit(latest)
            this.logger.error('task-manager', 'task_failed', {
              taskId: task.id,
              error: latest.error
            })
          }
        } finally {
          this.cancelled.delete(task.id)
        }
      }
    } finally {
      this.processing = false
    }
  }

  private async runTask(task: MigrationTask, connection: ConnectionConfig): Promise<void> {
    switch (task.type) {
      case 'postgres-export':
        await this.postgres.exportTable(
          connection,
          task.payload as PostgresExportRequest,
          (processed) => this.updateProgress(task, processed, { rows: processed }),
          cursorRows(task.cursor)
        )
        return
      case 'postgres-export-batch':
        await this.postgres.exportTables(
          connection,
          task.payload as PostgresBatchExportRequest,
          (processed, cursor) => this.updateProgress(task, processed, cursor ?? { rows: processed }),
          cursorBatchExport(task.cursor)
        )
        return
      case 'postgres-import':
        await this.postgres.importJsonl(
          connection,
          task.payload as PostgresImportRequest,
          (processed, line) =>
            this.updateProgress(task, processed, { lines: Number(line), rows: processed }),
          cursorImport(task.cursor)
        )
        return
      case 'elasticsearch-export':
        await this.elasticsearch.exportIndex(
          connection,
          task.payload as ElasticsearchExportRequest,
          (processed, cursor) => this.updateProgress(task, processed, cursor ?? { rows: processed }),
          {
            rows: cursorRows(task.cursor),
            searchAfter: cursorSearchAfter(task.cursor)
          }
        )
        return
      case 'elasticsearch-import':
        await this.elasticsearch.importJsonl(
          connection,
          task.payload as ElasticsearchImportRequest,
          (processed, line) =>
            this.updateProgress(task, processed, { lines: Number(line), rows: processed }),
          cursorImport(task.cursor)
        )
        return
      case 'mysql-export':
        await this.mysql.exportTable(
          connection,
          task.payload as MySQLExportRequest,
          (processed) => this.updateProgress(task, processed, { rows: processed }),
          cursorRows(task.cursor)
        )
        return
      case 'mysql-export-batch':
        await this.mysql.exportTables(
          connection,
          task.payload as MySQLBatchExportRequest,
          (processed, cursor) => this.updateProgress(task, processed, cursor ?? { rows: processed }),
          cursorBatchExport(task.cursor)
        )
        return
      case 'mysql-import':
        await this.mysql.importJsonl(
          connection,
          task.payload as MySQLImportRequest,
          (processed, line) =>
            this.updateProgress(task, processed, { lines: Number(line), rows: processed }),
          cursorImport(task.cursor)
        )
        return
      case 'sqlite-export':
        await this.sqlite.exportTable(
          connection,
          task.payload as SQLiteExportRequest,
          (processed) => this.updateProgress(task, processed, { rows: processed }),
          cursorRows(task.cursor)
        )
        return
      case 'sqlite-export-batch':
        await this.sqlite.exportTables(
          connection,
          task.payload as SQLiteBatchExportRequest,
          (processed, cursor) => this.updateProgress(task, processed, cursor ?? { rows: processed }),
          cursorBatchExport(task.cursor)
        )
        return
      case 'hive-export':
        await this.hive.exportTable(
          connection,
          task.payload as HiveExportRequest,
          (processed) => this.updateProgress(task, processed, { rows: processed }),
          cursorRows(task.cursor)
        )
        return
      case 'hive-import':
        {
          const result = await this.hive.importJsonl(
            connection,
            task.payload as HiveImportRequest,
            (processed, line) =>
              this.updateProgress(task, processed, { lines: Number(line), rows: processed }),
            cursorImport(task.cursor)
          )
          if (result.skipped) {
            this.logger.warn('hive-service', 'hive_import_rows_skipped', {
              taskId: task.id,
              skipped: result.skipped,
              warnings: result.warnings ?? []
            })
          }
        }
        return
    }
  }

  /**
   * 先提交进度/游标，再抛出取消信号。
   *
   * 所有 Source/Sink 都是“数据已落盘/已提交”之后才回调 onProgress（MySQL 与 PG 导出按批写盘、
   * ES bulk 与 PG insert 按批提交）。因此必须先持久化游标再中断，续传点才会与已写数据严格对齐：
   * cursor 恰好等于 `.part` 中已写入的行数，resume 时不会重复导出同一批。
   * 若先抛错再落游标（旧实现），`.part` 会领先 cursor 一个批次，重启后续传产生重复行。
   */
  private updateProgress(
    task: MigrationTask,
    processed: number,
    cursor?: unknown
  ): void {
    task.progress = processed
    if (cursor !== undefined) {
      task.cursor = cursor
    }
    this.store.update(task)
    this.emit(task)
    if (this.cancelled.has(task.id)) {
      throw new TaskCancelledError(task.id)
    }
  }

  private emit(task: MigrationTask): void {
    this.onChanged?.(task)
  }

  private removeFromQueue(id: string): void {
    const index = this.queue.indexOf(id)
    if (index >= 0) {
      this.queue.splice(index, 1)
    }
  }
}

function cursorRows(cursor: unknown): number {
  if (typeof cursor === 'number') {
    return cursor
  }
  if (isRecord(cursor) && typeof cursor.rows === 'number') {
    return cursor.rows
  }
  return 0
}

function cursorImport(cursor: unknown): { lines: number; rows: number } | undefined {
  if (isRecord(cursor) && typeof cursor.lines === 'number' && typeof cursor.rows === 'number') {
    return { lines: cursor.lines, rows: cursor.rows }
  }
  return undefined
}

function cursorSearchAfter(cursor: unknown): unknown[] | undefined {
  if (Array.isArray(cursor)) {
    return cursor
  }
  if (isRecord(cursor) && Array.isArray(cursor.searchAfter)) {
    return cursor.searchAfter
  }
  return undefined
}

function cursorBatchExport(
  cursor: unknown
): { tableIndex: number; rows: number } | undefined {
  if (isRecord(cursor) && typeof cursor.tableIndex === 'number') {
    return {
      tableIndex: cursor.tableIndex,
      rows: typeof cursor.rows === 'number' ? cursor.rows : 0
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '任务执行失败'
}

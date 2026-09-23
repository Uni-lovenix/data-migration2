import { randomUUID } from 'node:crypto'

import type {
  AccessExportRequest,
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
  Neo4jExportRequest,
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
import type { Neo4jService } from './neo4j-service'
import type { HiveService } from './hive-service'
import type { GoAccessService } from './go-access-service'
import type { PostgresService } from './postgres-service'
import type { SQLiteService } from './sqlite-service'
import { TaskCancelledError } from './task-errors'
import type { TaskStore } from './task-store'

export const DEFAULT_TASK_CONCURRENCY = 4

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
  neo4j: Pick<Neo4jService, 'exportTable'>
  access: Pick<GoAccessService, 'exportTable'>
  onChanged?: (task: MigrationTask) => void
  concurrency?: number
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
  private readonly neo4j: Pick<Neo4jService, 'exportTable'>
  private readonly access: Pick<GoAccessService, 'exportTable'>
  private readonly onChanged?: (task: MigrationTask) => void
  private readonly concurrency: number
  private readonly queue: string[] = []
  private readonly cancelled = new Set<string>()
  private activeCount = 0

  constructor(options: TaskManagerOptions) {
    this.store = options.store
    this.logger = options.logger
    this.connections = options.connections
    this.postgres = options.postgres
    this.elasticsearch = options.elasticsearch
    this.mysql = options.mysql
    this.sqlite = options.sqlite
    this.hive = options.hive
    this.neo4j = options.neo4j
    this.access = options.access
    this.onChanged = options.onChanged
    this.concurrency = normalizeConcurrency(options.concurrency)
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
    const shouldStart = input.start !== false
    const task: MigrationTask = {
      id: randomUUID(),
      type: input.type,
      status: shouldStart ? 'queued' : 'created',
      connectionId: input.payload.connectionId,
      payload: input.payload,
      dependsOn:
        input.dependsOn && input.dependsOn.length > 0
          ? [...new Set(input.dependsOn)]
          : undefined,
      template: input.template ? { ...input.template } : undefined,
      progress: 0,
      createdAt: now
    }
    this.store.insert(task)
    this.emit(task)
    if (shouldStart) {
      this.queue.push(task.id)
      this.logger.info('task-manager', 'task_queued', {
        taskId: task.id,
        type: task.type,
        connectionId: task.connectionId
      })
      this.pumpQueue()
    } else {
      this.logger.info('task-manager', 'task_created', {
        taskId: task.id,
        type: task.type,
        connectionId: task.connectionId
      })
    }
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
      this.pumpQueue()
      return task
    }
    if (task.status === 'running') {
      this.cancelled.add(id)
    }
    return task
  }

  resume(id: string): MigrationTask {
    const task = this.store.get(id)
    if (
      task.status !== 'created' &&
      task.status !== 'canceled' &&
      task.status !== 'failed' &&
      task.status !== 'paused'
    ) {
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
    this.pumpQueue()
    return task
  }

  private pumpQueue(): void {
    while (this.activeCount < this.concurrency) {
      const id = this.dequeueReadyTask()
      if (!id) {
        break
      }
      this.activeCount += 1
      void this.runQueuedTask(id)
        .catch((error) => {
          this.logger.error('task-manager', 'task_worker_error', {
            taskId: id,
            error: errorMessage(error)
          })
        })
        .finally(() => {
          this.activeCount -= 1
          this.pumpQueue()
        })
    }
  }

  private dequeueReadyTask(): string | undefined {
    for (let index = 0; index < this.queue.length; index += 1) {
      const id = this.queue[index]
      if (!id) {
        continue
      }
      const task = this.store.get(id)
      if (task.status !== 'queued') {
        this.queue.splice(index, 1)
        index -= 1
        continue
      }

      const dependencies = task.dependsOn ?? []
      let ready = true
      let blockedByFailure: string | undefined
      for (const dependencyId of dependencies) {
        let dependency: MigrationTask
        try {
          dependency = this.store.get(dependencyId)
        } catch {
          blockedByFailure = dependencyId
          ready = false
          break
        }
        if (dependency.status === 'completed') {
          continue
        }
        if (dependency.status === 'failed' || dependency.status === 'canceled') {
          blockedByFailure = dependencyId
        }
        ready = false
        break
      }

      if (blockedByFailure) {
        this.queue.splice(index, 1)
        this.failDependency(task, blockedByFailure)
        index -= 1
        continue
      }
      if (ready) {
        this.queue.splice(index, 1)
        return id
      }
    }
    return undefined
  }

  private failDependency(task: MigrationTask, dependencyId: string): void {
    task.status = 'failed'
    task.error = `依赖任务未完成：${dependencyId}`
    task.finishedAt = new Date().toISOString()
    this.store.update(task)
    this.emit(task)
    this.logger.error('task-manager', 'task_dependency_failed', {
      taskId: task.id,
      dependencyId
    })
  }

  private async runQueuedTask(id: string): Promise<void> {
    if (this.cancelled.has(id)) {
      this.cancelled.delete(id)
      const canceled = this.store.get(id)
      canceled.status = 'canceled'
      canceled.finishedAt = new Date().toISOString()
      this.store.update(canceled)
      this.emit(canceled)
      return
    }

    const task = this.store.get(id)
    if (task.status !== 'queued') {
      return
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
            searchAfter: cursorSearchAfter(task.cursor),
            cursor: task.cursor
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
      case 'neo4j-export':
        await this.neo4j.exportTable(
          connection,
          task.payload as Neo4jExportRequest,
          (processed) => this.updateProgress(task, processed, { rows: processed }),
          cursorRows(task.cursor)
        )
        return
      case 'access-export':
        await this.access.exportTable(
          connection,
          task.payload as AccessExportRequest,
          (processed) => this.updateProgress(task, processed, { rows: processed }),
          cursorRows(task.cursor)
        )
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

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_TASK_CONCURRENCY
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('任务并发度必须是大于等于 1 的整数')
  }
  return value
}

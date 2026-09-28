import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type {
  AccessExportRequest,
  ConnectionConfig,
  CreateMigrationTaskInput,
  ElasticsearchExportRequest,
  ElasticsearchDirectRequest,
  ElasticsearchImportRequest,
  ElasticsearchMirrorArchiveRequest,
  ElasticsearchMirrorRequest,
  HiveExportRequest,
  HiveImportRequest,
  MigrationTask,
  MySQLBatchExportRequest,
  MySQLExportRequest,
  MySQLImportRequest,
  Neo4jExportRequest,
  PostgresBatchExportRequest,
  PostgresDirectRequest,
  PostgresExportRequest,
  PostgresImportRequest,
  PostgresRollbackRequest,
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
import { RollbackConflictError, TaskCancelledError } from './task-errors'
import { archiveIndexToHdfs } from './mirror-archive-service'
import type { HdfsService } from './hdfs-service'
import type { TaskStore } from './task-store'

export const DEFAULT_TASK_CONCURRENCY = 4

interface TaskManagerOptions {
  store: TaskStore
  logger: StructuredLogger
  connections: Pick<ConnectionStore, 'get'>
  postgres: Pick<
    PostgresService,
    | 'exportTable'
    | 'exportTables'
    | 'importJsonl'
    | 'directMigrateTable'
    | 'rollbackDirectMigration'
  >
  elasticsearch: Pick<
    ElasticsearchService,
    'exportIndex' | 'importJsonl'
  >
  /**
   * 直连迁移与回滚走主进程 Node 实现（与 PostgreSQL 直连一致）：
   * 文件路径的 ES 导出/导入仍由 Go 引擎负责，两者互不影响。
   */
  elasticsearchDirect: Pick<
    ElasticsearchService,
    'directMigrateIndex' | 'rollbackDirectMigration' | 'mirrorIndex' | 'streamIndexBatches' | 'readIndexMetadata'
  >
  /** HDFS 镜像存档使用（WebHDFS）。 */
  hdfs: Pick<HdfsService, 'exists' | 'mkdirs' | 'writeFile' | 'delete'>
  mysql: Pick<MySQLService, 'exportTable' | 'exportTables' | 'importJsonl'>
  sqlite: Pick<SQLiteService, 'exportTable' | 'exportTables'>
  hive: Pick<HiveService, 'exportTable' | 'importJsonl'>
  neo4j: Pick<Neo4jService, 'exportTable'>
  access: Pick<GoAccessService, 'exportTable'>
  onChanged?: (task: MigrationTask) => void
  concurrency?: number
  /** 直连迁移的撤销日志等控制文件目录。 */
  controlDirectory: string
}

export class TaskManager {
  private readonly store: TaskStore
  private readonly logger: StructuredLogger
  private readonly connections: Pick<ConnectionStore, 'get'>
  private readonly postgres: Pick<
    PostgresService,
    | 'exportTable'
    | 'exportTables'
    | 'importJsonl'
    | 'directMigrateTable'
    | 'rollbackDirectMigration'
  >
  private readonly elasticsearch: Pick<
    ElasticsearchService,
    'exportIndex' | 'importJsonl'
  >
  private readonly elasticsearchDirect: Pick<
    ElasticsearchService,
    'directMigrateIndex' | 'rollbackDirectMigration' | 'mirrorIndex' | 'streamIndexBatches' | 'readIndexMetadata'
  >
  private readonly hdfs: Pick<HdfsService, 'exists' | 'mkdirs' | 'writeFile' | 'delete'>
  private readonly mysql: Pick<MySQLService, 'exportTable' | 'exportTables' | 'importJsonl'>
  private readonly sqlite: Pick<SQLiteService, 'exportTable' | 'exportTables'>
  private readonly hive: Pick<HiveService, 'exportTable' | 'importJsonl'>
  private readonly neo4j: Pick<Neo4jService, 'exportTable'>
  private readonly access: Pick<GoAccessService, 'exportTable'>
  private readonly onChanged?: (task: MigrationTask) => void
  private readonly concurrency: number
  private readonly controlDirectory: string
  private readonly queue: string[] = []
  private readonly cancelled = new Set<string>()
  private activeCount = 0

  constructor(options: TaskManagerOptions) {
    this.store = options.store
    this.logger = options.logger
    this.connections = options.connections
    this.postgres = options.postgres
    this.elasticsearch = options.elasticsearch
    this.elasticsearchDirect = options.elasticsearchDirect
    this.hdfs = options.hdfs
    this.mysql = options.mysql
    this.sqlite = options.sqlite
    this.hive = options.hive
    this.neo4j = options.neo4j
    this.access = options.access
    this.onChanged = options.onChanged
    this.concurrency = normalizeConcurrency(options.concurrency)
    this.controlDirectory = options.controlDirectory
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
      connectionId:
        'connectionId' in input.payload ? input.payload.connectionId : '',
      payload: input.payload,
      dependsOn:
        input.dependsOn && input.dependsOn.length > 0
          ? [...new Set(input.dependsOn)]
          : undefined,
      template: input.template ? { ...input.template } : undefined,
      rollback: input.rollback ? { ...input.rollback } : undefined,
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
    if (task.type === 'postgres-direct' && task.progress > 0) {
      throw new Error(
        '直连迁移不支持中断后续传：请先回滚本次任务，或新建一个迁移任务'
      )
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
      const connection = await this.resolveTaskConnection(task)
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
        this.maybeScheduleAutoRollback(latest, 'cancel')
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
        this.maybeScheduleAutoRollback(latest, 'failure')
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
      case 'postgres-direct':
        await this.runDirectMigration(task, connection)
        return
      case 'postgres-rollback':
        await this.runRollback(task)
        return
      case 'elasticsearch-direct':
        await this.runElasticsearchDirect(task, connection)
        return
      case 'elasticsearch-rollback':
        await this.runRollback(task)
        return
      case 'elasticsearch-mirror':
        await this.runElasticsearchMirror(task, connection)
        return
      case 'elasticsearch-mirror-archive':
        await this.runMirrorArchive(task, connection)
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

  /** 直连迁移：源库流式读取后直接写入目标库，并在批次边界持久化撤销日志。 */
  /**
   * 解析任务使用的连接。回滚任务没有自己的连接字段，
   * 使用被回滚任务的**目标端**连接。
   */
  private resolveTaskConnection(task: MigrationTask): Promise<ConnectionConfig> {
    if (task.type === 'postgres-rollback' || task.type === 'elasticsearch-rollback') {
      const request = task.payload as PostgresRollbackRequest
      const original = this.store.get(request.taskId)
      const payload = original.payload as PostgresDirectRequest | ElasticsearchDirectRequest
      return this.connections.get(payload.targetConnectionId)
    }
    return this.connections.get(task.connectionId)
  }

  private async runDirectMigration(
    task: MigrationTask,
    source: ConnectionConfig
  ): Promise<void> {
    const request = task.payload as PostgresDirectRequest
    const target = await this.connections.get(request.targetConnectionId)
    const journalPath = directJournalPath(this.controlDirectory, task.id)

    // 回滚元数据必须在执行前落盘：任务中途失败时，回滚任务才知道日志在哪。
    // 注意：进度回调会用同一个 task 对象写库，因此这里必须改在内存对象上，
    // 否则后续 updateProgress 会把 rollback 字段覆盖成 NULL。
    task.rollback = {
      state: request.rollbackOn === 'none' ? 'none' : 'available',
      journalPath: request.rollbackOn === 'none' ? undefined : journalPath
    }
    this.store.update(task)
    this.emit(task)

    this.logger.info('task-manager', 'direct_migration_started', {
      taskId: task.id,
      sourceConnectionId: request.connectionId,
      targetConnectionId: request.targetConnectionId,
      targetTable: `${request.targetTable.schema}.${request.targetTable.name}`,
      conflictPolicy: request.conflictPolicy,
      rollbackOn: request.rollbackOn
    })

    const result = await this.postgres.directMigrateTable(
      source,
      target,
      request,
      { taskId: task.id, journalPath },
      (processed, cursor) => this.updateProgress(task, processed, cursor)
    )

    const latest = this.store.get(task.id)
    latest.rollback = {
      state: request.rollbackOn === 'none' ? 'none' : 'available',
      ...(result.undoJournalPath ? { journalPath: result.undoJournalPath } : {}),
      ...(result.tableCreated ? { targetCreated: true } : {}),
      writtenRows: result.rows
    }
    this.store.update(latest)
    this.emit(latest)
    this.logger.info('task-manager', 'direct_migration_completed', {
      taskId: task.id,
      rows: result.rows,
      skipped: result.skipped,
      rollbackState: latest.rollback.state
    })
  }

  /** Elasticsearch 直连迁移：源索引流式读取后直接 bulk 写入目标索引。 */
  private async runElasticsearchDirect(
    task: MigrationTask,
    source: ConnectionConfig
  ): Promise<void> {
    const request = task.payload as ElasticsearchDirectRequest
    const target = await this.connections.get(request.targetConnectionId)
    const journalPath = directJournalPath(this.controlDirectory, task.id)

    // 与 PostgreSQL 直连同理：回滚元数据在执行前落盘，且必须改在内存对象上，
    // 否则后续 updateProgress 会把 rollback 字段覆盖成 NULL。
    task.rollback = {
      state: request.rollbackOn === 'none' ? 'none' : 'available',
      journalPath: request.rollbackOn === 'none' ? undefined : journalPath
    }
    this.store.update(task)
    this.emit(task)

    this.logger.info('task-manager', 'direct_migration_started', {
      taskId: task.id,
      engine: 'elasticsearch',
      sourceConnectionId: request.connectionId,
      targetConnectionId: request.targetConnectionId,
      sourceIndex: request.index,
      targetIndex: request.targetIndex,
      conflictPolicy: request.conflictPolicy,
      rollbackOn: request.rollbackOn
    })

    const result = await this.elasticsearchDirect.directMigrateIndex(
      source,
      target,
      request,
      { taskId: task.id, journalPath },
      (processed, cursor) => this.updateProgress(task, processed, cursor)
    )

    const latest = this.store.get(task.id)
    latest.rollback = {
      state: request.rollbackOn === 'none' ? 'none' : 'available',
      ...(result.undoJournalPath ? { journalPath: result.undoJournalPath } : {}),
      writtenRows: result.rows
    }
    this.store.update(latest)
    this.emit(latest)
    this.logger.info('task-manager', 'direct_migration_completed', {
      taskId: task.id,
      engine: 'elasticsearch',
      rows: result.rows,
      skipped: result.skipped,
      rollbackState: latest.rollback.state
    })
  }

  /** 回滚一次直连迁移任务，并把结果写回原任务的回滚元数据。 */
  /** 同索引镜像迁移：源索引 -> 目标集群同名索引（含 schema 复制）。 */
  private async runElasticsearchMirror(
    task: MigrationTask,
    source: ConnectionConfig
  ): Promise<void> {
    const request = task.payload as ElasticsearchMirrorRequest
    const target = await this.connections.get(request.targetConnectionId)
    const journalPath = directJournalPath(this.controlDirectory, task.id)

    task.rollback = {
      state: request.rollbackOn === 'none' ? 'none' : 'available',
      journalPath: request.rollbackOn === 'none' ? undefined : journalPath
    }
    this.store.update(task)
    this.emit(task)

    this.logger.info('task-manager', 'mirror_migration_started', {
      taskId: task.id,
      engine: 'elasticsearch',
      index: request.index,
      targetConnectionId: request.targetConnectionId,
      conflictPolicy: request.conflictPolicy,
      createTargetIndex: request.createTargetIndex !== false,
      copyAliases: request.copyAliases === true,
      rollbackOn: request.rollbackOn
    })

    const result = await this.elasticsearchDirect.mirrorIndex(
      source,
      target,
      request,
      { taskId: task.id, journalPath },
      (processed, cursor) => this.updateProgress(task, processed, cursor)
    )

    const latest = this.store.get(task.id)
    latest.rollback = {
      state: request.rollbackOn === 'none' ? 'none' : 'available',
      ...(result.undoJournalPath ? { journalPath: result.undoJournalPath } : {}),
      writtenRows: result.rows,
      ...(result.targetCreated ? { targetCreated: true } : {})
    }
    this.store.update(latest)
    this.emit(latest)
    this.logger.info('task-manager', 'mirror_migration_completed', {
      taskId: task.id,
      index: request.index,
      rows: result.rows,
      skipped: result.skipped,
      targetCreated: result.targetCreated,
      aliasesCopied: result.aliasesCopied
    })
  }

  /** HDFS 镜像存档：索引 metadata + 数据分片写入 HDFS。 */
  private async runMirrorArchive(
    task: MigrationTask,
    source: ConnectionConfig
  ): Promise<void> {
    const request = task.payload as ElasticsearchMirrorArchiveRequest
    const hdfsConnection = await this.connections.get(request.hdfsConnectionId)

    this.logger.info('task-manager', 'mirror_archive_started', {
      taskId: task.id,
      index: request.index,
      hdfs: `${hdfsConnection.host}:${hdfsConnection.port}`,
      directory: request.hdfsDirectory
    })

    const result = await archiveIndexToHdfs({
      connection: source,
      hdfsConnection,
      request,
      elasticsearch: this.elasticsearchDirect,
      hdfs: this.hdfs,
      onProgress: (rows, cursor) => this.updateProgress(task, rows, cursor)
    })

    this.logger.info('task-manager', 'mirror_archive_completed', {
      taskId: task.id,
      index: request.index,
      rows: result.rows,
      parts: result.parts,
      manifest: result.manifestPath
    })
  }

  /** 回滚一次直连迁移任务，并把结果写回原任务的回滚元数据。 */
  private async runRollback(task: MigrationTask): Promise<void> {
    const request = task.payload as PostgresRollbackRequest
    const original = this.store.get(request.taskId)
    const metadata = original.rollback
    if (!metadata?.journalPath) {
      throw new Error('该任务没有可用的撤销日志，无法回滚')
    }
    const engine =
      original.type === 'elasticsearch-direct' || original.type === 'elasticsearch-mirror'
        ? 'elasticsearch'
        : 'postgres'
    const target =
      engine === 'elasticsearch'
        ? await this.connections.get(
            (original.payload as ElasticsearchDirectRequest).targetConnectionId
          )
        : await this.connections.get(
            (original.payload as PostgresDirectRequest).targetConnectionId
          )

    this.logger.warn('task-manager', 'rollback_started', {
      taskId: task.id,
      targetTaskId: original.id,
      engine,
      conflictPolicy: request.conflictPolicy ?? 'abort',
      ...(engine === 'postgres'
        ? {
            dropCreatedTarget: Boolean(
              metadata.targetCreated &&
                (original.payload as PostgresDirectRequest).dropCreatedTarget
            )
          }
        : {})
    })

    try {
      const result =
        engine === 'elasticsearch'
          ? await this.elasticsearchDirect.rollbackDirectMigration(
              target,
              {
                taskId: original.id,
                journalPath: metadata.journalPath,
                conflictPolicy: request.conflictPolicy ?? 'abort',
                dropCreatedTarget:
                  original.type === 'elasticsearch-mirror' &&
                  Boolean(
                    metadata.targetCreated &&
                      (original.payload as ElasticsearchMirrorRequest).dropCreatedTarget !==
                        false
                  )
              },
              (processed, cursor) => this.updateProgress(task, processed, cursor)
            )
          : await this.postgres.rollbackDirectMigration(
              target,
              {
                taskId: original.id,
                journalPath: metadata.journalPath,
                conflictPolicy: request.conflictPolicy ?? 'abort',
                ...((original.payload as PostgresDirectRequest).targetDatabase
                  ? {
                      targetDatabase: (original.payload as PostgresDirectRequest)
                        .targetDatabase
                    }
                  : {}),
                targetTable: (original.payload as PostgresDirectRequest).targetTable,
                dropCreatedTarget: Boolean(
                  metadata.targetCreated &&
                    (original.payload as PostgresDirectRequest).dropCreatedTarget
                )
              },
              (processed, cursor) => this.updateProgress(task, processed, cursor)
            )
      const updated = this.store.get(original.id)
      updated.rollback = {
        ...updated.rollback,
        state: 'rolled-back',
        rollbackTaskId: task.id,
        result,
        message: undefined
      }
      this.store.update(updated)
      this.emit(updated)
      this.logger.info('task-manager', 'rollback_completed', {
        taskId: task.id,
        targetTaskId: original.id,
        deletedRows: result.deletedRows,
        restoredRows: result.restoredRows,
        skippedConflicts: result.skippedConflicts
      })
    } catch (error) {
      const updated = this.store.get(original.id)
      updated.rollback = {
        ...updated.rollback,
        state:
          error instanceof RollbackConflictError ? 'rollback-conflict' : 'rollback-failed',
        rollbackTaskId: task.id,
        message: errorMessage(error)
      }
      this.store.update(updated)
      this.emit(updated)
      throw error
    }
  }

  /** 直连任务失败/取消后，按策略自动入队回滚任务。 */
  private maybeScheduleAutoRollback(
    task: MigrationTask,
    reason: 'failure' | 'cancel'
  ): void {
    const rollbackType =
      task.type === 'postgres-direct'
        ? 'postgres-rollback'
        : task.type === 'elasticsearch-direct' || task.type === 'elasticsearch-mirror'
          ? 'elasticsearch-rollback'
          : undefined
    if (!rollbackType) {
      return
    }
    const payload = task.payload as PostgresDirectRequest | ElasticsearchDirectRequest
    if (payload.rollbackOn === 'none' || !task.rollback?.journalPath) {
      return
    }
    if (task.progress <= 0) {
      // 一个批次都没有提交，目标端不存在本任务的写入，无需回滚。
      const idle = this.store.get(task.id)
      idle.rollback = { ...idle.rollback, state: 'none' }
      this.store.update(idle)
      this.emit(idle)
      return
    }

    const autoRollback =
      payload.rollbackOn === 'failure-or-cancel' ||
      (payload.rollbackOn === 'failure' && reason === 'failure')

    if (!autoRollback) {
      // 需要用户显式触发：只把状态标成待回滚，保留撤销日志。
      const pending = this.store.get(task.id)
      pending.rollback = { ...pending.rollback, state: 'pending' }
      this.store.update(pending)
      this.emit(pending)
      this.logger.warn('task-manager', 'manual_rollback_available', {
        taskId: task.id,
        reason
      })
      return
    }

    const rollbackTask = this.create({
      type: rollbackType,
      payload: {
        taskId: task.id,
        conflictPolicy: payload.rollbackConflictPolicy ?? 'abort',
        riskAck: {
          version: payload.riskAck.version,
          acknowledgedAt: new Date().toISOString(),
          acknowledgedBy: 'auto'
        }
      } satisfies PostgresRollbackRequest,
      start: true
    })

    const updated = this.store.get(task.id)
    updated.rollback = {
      ...updated.rollback,
      state: 'pending',
      rollbackTaskId: rollbackTask.id
    }
    this.store.update(updated)
    this.emit(updated)
    this.logger.warn('task-manager', 'auto_rollback_scheduled', {
      taskId: task.id,
      rollbackTaskId: rollbackTask.id,
      reason
    })
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

/** 撤销日志路径：每个直连任务一个文件，重跑同一任务时沿用同一日志。 */
function directJournalPath(controlDirectory: string, taskId: string): string {
  return join(controlDirectory, `${taskId}.undo.jsonl`)
}

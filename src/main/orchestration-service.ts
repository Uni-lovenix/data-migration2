import type {
  CastDryRunRequest,
  CastDryRunResult,
  ExportPreviewRequest,
  ExportPreviewResult,
  ImportValidateRequest,
  ImportValidateResult,
  OrchestrationResult,
  OrchestrationStep
} from '../shared/types'
import { validateCreateMigrationTaskInput } from '../shared/validation'
import { transformRecord } from '../shared/type-conversion'
import type { ConnectionStore } from './connection-store'
import type { ElasticsearchService } from './elasticsearch-service'
import type { HiveService } from './hive-service'
import type { MySQLService } from './mysql-service'
import type { PostgresService } from './postgres-service'
import type { SQLiteService } from './sqlite-service'
import type { TaskManager } from './task-manager'

interface OrchestrationServiceOptions {
  connections: Pick<ConnectionStore, 'get'>
  postgres: Pick<PostgresService, 'previewTable' | 'listTables'>
  mysql: Pick<MySQLService, 'previewTable' | 'listTables'>
  sqlite: Pick<SQLiteService, 'previewTable'>
  hive: Pick<HiveService, 'previewTable' | 'listColumns'>
  elasticsearch: Pick<ElasticsearchService, 'previewIndex'>
  taskManager: Pick<TaskManager, 'create' | 'cancel'>
  templateExecute?: (
    id: string,
    vars: Record<string, string>
  ) => Promise<{ taskId: string; taskIds: string[] }>
}

export class OrchestrationService {
  private readonly options: OrchestrationServiceOptions

  constructor(options: OrchestrationServiceOptions) {
    this.options = options
  }

  async exportPreview(request: ExportPreviewRequest): Promise<ExportPreviewResult> {
    const connection = await this.options.connections.get(request.connectionId)
    const limit = clampLimit(request.limit)
    let rows: Array<Record<string, unknown>>

    if (request.source === 'postgresql') {
      if (!request.table || !('schema' in request.table)) {
        throw new Error('PostgreSQL preview 需要 table.schema/name')
      }
      rows = await this.options.postgres.previewTable(
        connection,
        { schema: request.table.schema, name: request.table.name },
        limit
      )
    } else if (request.source === 'mysql') {
      if (!request.table || !('schema' in request.table)) {
        throw new Error('MySQL preview 需要 table.schema/name')
      }
      rows = await this.options.mysql.previewTable(
        connection,
        { schema: request.table.schema, name: request.table.name },
        limit
      )
    } else if (request.source === 'sqlite') {
      if (!request.table || !('schema' in request.table)) {
        throw new Error('SQLite preview 需要 table.schema/name')
      }
      rows = await this.options.sqlite.previewTable(
        connection,
        { schema: request.table.schema, name: request.table.name },
        limit
      )
    } else if (request.source === 'hive') {
      if (!request.table || !('database' in request.table)) {
        throw new Error('Hive preview 需要 table.database/name')
      }
      rows = await this.options.hive.previewTable(connection, request.table, limit)
    } else {
      if (!request.index) {
        throw new Error('Elasticsearch preview 需要 index')
      }
      rows = await this.options.elasticsearch.previewIndex(
        connection,
        request.index,
        limit
      )
    }

    return {
      source: request.source,
      columns: collectColumns(rows),
      rows
    }
  }

  async importValidate(
    request: ImportValidateRequest
  ): Promise<ImportValidateResult> {
    const connection = await this.options.connections.get(request.connectionId)
    let existingColumns: string[] | undefined

    if (request.target === 'postgresql') {
      if (!request.table || !('schema' in request.table)) {
        throw new Error('PostgreSQL import validate 需要 table.schema/name')
      }
      const tableRef = {
        schema: request.table.schema,
        name: request.table.name
      }
      const tables = await this.options.postgres.listTables(connection)
      const table = tables.find(
        (item) => item.schema === tableRef.schema && item.name === tableRef.name
      )
      existingColumns = table?.columns.map((column) => column.name)
    } else if (request.target === 'mysql') {
      if (!request.table || !('schema' in request.table)) {
        throw new Error('MySQL import validate 需要 table.schema/name')
      }
      const tableRef = {
        schema: request.table.schema,
        name: request.table.name
      }
      const tables = await this.options.mysql.listTables(
        connection,
        tableRef.schema
      )
      const table = tables.find((item) => item.name === tableRef.name)
      existingColumns = table?.columns.map((column) => column.name)
    } else if (request.target === 'hive') {
      if (!request.table || !('database' in request.table)) {
        throw new Error('Hive import validate 需要 table.database/name')
      }
      existingColumns = await this.options.hive.listColumns(connection, request.table)
    }

    const existing = new Set(existingColumns ?? [])
    const missingColumns =
      existingColumns === undefined
        ? []
        : request.columns.filter((column) => !existing.has(column))
    if (missingColumns.length > 0) {
      throw new Error(`目标缺少列：${missingColumns.join(', ')}`)
    }
    return {
      target: request.target,
      ok: true,
      missingColumns,
      ...(existingColumns ? { existingColumns } : {})
    }
  }

  castDryRun(request: CastDryRunRequest): CastDryRunResult {
    const targetTypes = new Map(Object.entries(request.targetTypes ?? {}))
    return {
      row: transformRecord(request.row, request.transforms, targetTypes)
    }
  }

  async executeStep(step: OrchestrationStep): Promise<unknown> {
    const atom = normalizeAtom(step.atom)
    if (atom === 'export_preview') {
      return this.exportPreview(step as unknown as ExportPreviewRequest)
    }
    if (atom === 'import_validate') {
      return this.importValidate(step as unknown as ImportValidateRequest)
    }
    if (atom === 'cast_dry_run') {
      return this.castDryRun(step as unknown as CastDryRunRequest)
    }
    if (atom === 'task_create') {
      const input = step.input ?? step
      const validated = validateCreateMigrationTaskInput(input)
      if (!validated.ok) {
        throw new Error(validated.errors.join('；'))
      }
      return this.options.taskManager.create(validated.value)
    }
    if (atom === 'task_cancel') {
      const id = typeof step.id === 'string' ? step.id : ''
      if (!id) {
        throw new Error('task_cancel 需要 id')
      }
      return this.options.taskManager.cancel(id)
    }
    if (atom === 'template_execute') {
      if (!this.options.templateExecute) {
        throw new Error('template_execute 未配置')
      }
      const id = typeof step.id === 'string' ? step.id : ''
      if (!id) {
        throw new Error('template_execute 需要 id')
      }
      return this.options.templateExecute(
        id,
        isRecord(step.vars) ? (step.vars as Record<string, string>) : {}
      )
    }
    throw new Error(`未知原子：${step.atom}`)
  }

  async orchestrate(steps: OrchestrationStep[]): Promise<OrchestrationResult> {
    if (!Array.isArray(steps)) {
      throw new Error('steps 必须是数组')
    }
    const results: OrchestrationResult['steps'] = []
    let failed = false
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]
      if (!step || typeof step.atom !== 'string') {
        results.push({
          index,
          atom: String(step?.atom ?? ''),
          status: 'failed',
          error: 'step.atom 必须是非空字符串'
        })
        failed = true
        continue
      }
      if (failed) {
        results.push({ index, atom: step.atom, status: 'skipped' })
        continue
      }
      try {
        results.push({
          index,
          atom: step.atom,
          status: 'completed',
          result: await this.executeStep(step)
        })
      } catch (error) {
        failed = true
        results.push({
          index,
          atom: step.atom,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return {
      steps: results,
      summary: {
        total: results.length,
        completed: results.filter((item) => item.status === 'completed').length,
        failed: results.filter((item) => item.status === 'failed').length,
        skipped: results.filter((item) => item.status === 'skipped').length
      }
    }
  }
}

function normalizeAtom(value: string): string {
  return value.replace(/[.-]/g, '_')
}

function clampLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.trunc(value), 1000)) : 20
}

function collectColumns(rows: Array<Record<string, unknown>>): string[] {
  const columns: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (!seen.has(column)) {
        seen.add(column)
        columns.push(column)
      }
    }
  }
  return columns
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

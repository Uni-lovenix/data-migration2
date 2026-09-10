import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

import initSqlJs from 'sql.js'
import type { SqlJsStatic } from 'sql.js'

import type {
  CreateTemplateInput,
  MigrationTemplate,
  TemplateStep,
  TemplateVariable,
  UpdateTemplateInput
} from '../shared/types'

type SqlDatabase = InstanceType<SqlJsStatic['Database']>
type SqlStatement = InstanceType<SqlJsStatic['Statement']>

export class TemplateStore {
  private db: SqlDatabase | null = null
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async initialize(): Promise<void> {
    const require = createRequire(import.meta.url)
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
    const SQL = await initSqlJs({ locateFile: () => wasmPath })

    let data: Uint8Array | null = null
    try {
      const raw = readFileSync(this.filePath)
      data = new Uint8Array(raw)
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error
      }
    }

    this.db = data ? new SQL.Database(data) : new SQL.Database()
    this.db.run(`
      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        engine TEXT NOT NULL,
        action TEXT NOT NULL,
        connection_name TEXT NOT NULL,
        dst_connection_name TEXT,
        config_json TEXT NOT NULL,
        variables TEXT NOT NULL DEFAULT '[]',
        steps TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    // Idempotent upgrades for databases created before dst_connection_name / steps existed.
    // sql.js doesn't support `ADD COLUMN IF NOT EXISTS`, so swallow the duplicate-column error.
    try {
      this.db.run('ALTER TABLE templates ADD COLUMN dst_connection_name TEXT')
    } catch (error) {
      if (!isDuplicateColumnError(error)) throw error
    }
    try {
      this.db.run('ALTER TABLE templates ADD COLUMN steps TEXT NOT NULL DEFAULT "[]"')
    } catch (error) {
      if (!isDuplicateColumnError(error)) throw error
    }
    this.persist()
  }

  list(): MigrationTemplate[] {
    const statement = this.prepare('SELECT * FROM templates ORDER BY created_at DESC')
    const templates: MigrationTemplate[] = []
    while (statement.step()) {
      templates.push(mapTemplate(statement.getAsObject()))
    }
    statement.free()
    return templates
  }

  get(id: string): MigrationTemplate {
    const statement = this.prepare('SELECT * FROM templates WHERE id = ?', [id])
    if (!statement.step()) {
      statement.free()
      throw new Error(`模板不存在：${id}`)
    }
    const template = mapTemplate(statement.getAsObject())
    statement.free()
    return template
  }

  create(input: CreateTemplateInput): MigrationTemplate {
    const now = new Date().toISOString()
    const template: MigrationTemplate = {
      id: crypto.randomUUID(),
      name: input.name,
      description: input.description,
      engine: input.engine,
      action: input.action,
      connectionName: input.connectionName,
      dstConnectionName: input.dstConnectionName,
      configJson: input.configJson,
      variables: input.variables ?? [],
      steps: input.steps ?? [],
      createdAt: now,
      updatedAt: now
    }
    const db = this.requireDb()
    db.run(
      `INSERT INTO templates (
        id, name, description, engine, action, connection_name,
        dst_connection_name, config_json, variables, steps,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        template.id,
        template.name,
        template.description ?? null,
        template.engine,
        template.action,
        template.connectionName,
        template.dstConnectionName ?? null,
        template.configJson,
        JSON.stringify(template.variables),
        JSON.stringify(template.steps),
        template.createdAt,
        template.updatedAt
      ]
    )
    this.persist()
    return template
  }

  update(id: string, input: UpdateTemplateInput): MigrationTemplate {
    const existing = this.get(id)
    const now = new Date().toISOString()
    const updated: MigrationTemplate = {
      ...existing,
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      connectionName: input.connectionName ?? existing.connectionName,
      dstConnectionName: input.dstConnectionName ?? existing.dstConnectionName,
      configJson: input.configJson ?? existing.configJson,
      variables: input.variables ?? existing.variables,
      steps: input.steps ?? existing.steps,
      updatedAt: now
    }
    const db = this.requireDb()
    db.run(
      `UPDATE templates SET
        name = ?, description = ?, connection_name = ?,
        dst_connection_name = ?, config_json = ?,
        variables = ?, steps = ?, updated_at = ?
      WHERE id = ?`,
      [
        updated.name,
        updated.description ?? null,
        updated.connectionName,
        updated.dstConnectionName ?? null,
        updated.configJson,
        JSON.stringify(updated.variables),
        JSON.stringify(updated.steps),
        updated.updatedAt,
        id
      ]
    )
    this.persist()
    return updated
  }

  delete(id: string): void {
    const db = this.requireDb()
    db.run('DELETE FROM templates WHERE id = ?', [id])
    this.persist()
  }

  findByName(name: string): MigrationTemplate | undefined {
    const statement = this.prepare('SELECT * FROM templates WHERE name = ? LIMIT 1', [name])
    if (!statement.step()) {
      statement.free()
      return undefined
    }
    const template = mapTemplate(statement.getAsObject())
    statement.free()
    return template
  }

  close(): void {
    this.db?.close()
    this.db = null
  }

  private prepare(sql: string, params: Array<string | number | null> = []): SqlStatement {
    const statement = this.requireDb().prepare(sql)
    if (params.length > 0) {
      statement.bind(params)
    }
    return statement
  }

  private requireDb(): SqlDatabase {
    if (!this.db) {
      throw new Error('模板存储尚未初始化')
    }
    return this.db
  }

  private persist(): void {
    const db = this.requireDb()
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    writeFileSync(temporaryPath, Buffer.from(db.export()))
    renameSync(temporaryPath, this.filePath)
  }
}

function mapTemplate(row: Record<string, unknown>): MigrationTemplate {
  return {
    id: String(row.id),
    name: String(row.name),
    description: nullableString(row.description),
    engine: String(row.engine) as MigrationTemplate['engine'],
    action: String(row.action) as MigrationTemplate['action'],
    connectionName: String(row.connection_name),
    dstConnectionName: nullableString(row.dst_connection_name),
    configJson: String(row.config_json),
    variables: parseVariables(row.variables),
    steps: parseSteps(row.steps),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function parseVariables(value: unknown): TemplateVariable[] {
  return parseJsonArray<TemplateVariable>(value)
}

function parseSteps(value: unknown): TemplateStep[] {
  return parseJsonArray<TemplateStep>(value)
}

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== 'string' || value.length === 0) {
    return []
  }
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function nullableString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

function isDuplicateColumnError(value: unknown): boolean {
  // sql.js raises SqliteError messages like "duplicate column name: dst_connection_name".
  return value instanceof Error && /duplicate column name/i.test(value.message)
}

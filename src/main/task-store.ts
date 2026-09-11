import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

import initSqlJs from 'sql.js'
import type { SqlJsStatic } from 'sql.js'

import type { MigrationTask } from '../shared/types'

type SqlDatabase = InstanceType<SqlJsStatic['Database']>
type SqlStatement = InstanceType<SqlJsStatic['Statement']>

export class TaskStore {
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
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        cursor TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      )
    `)
    this.persist()
  }

  list(): MigrationTask[] {
    const statement = this.prepare(
      'SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC'
    )
    const tasks: MigrationTask[] = []
    while (statement.step()) {
      tasks.push(mapTask(statement.getAsObject()))
    }
    statement.free()
    return tasks
  }

  get(id: string): MigrationTask {
    const statement = this.prepare('SELECT * FROM tasks WHERE id = ?', [id])
    if (!statement.step()) {
      statement.free()
      throw new Error(`任务不存在：${id}`)
    }
    const task = mapTask(statement.getAsObject())
    statement.free()
    return task
  }

  insert(task: MigrationTask): void {
    const db = this.requireDb()
    db.run(
      `INSERT INTO tasks (
        id, type, status, connection_id, payload, progress, cursor, error,
        created_at, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.type,
        task.status,
        task.connectionId,
        JSON.stringify(task.payload),
        task.progress,
        jsonOrNull(task.cursor),
        task.error ?? null,
        task.createdAt,
        task.startedAt ?? null,
        task.finishedAt ?? null
      ]
    )
    this.persist()
  }

  update(task: MigrationTask): void {
    const db = this.requireDb()
    db.run(
      `UPDATE tasks
       SET status = ?, progress = ?, cursor = ?, error = ?,
           started_at = ?, finished_at = ?
       WHERE id = ?`,
      [
        task.status,
        task.progress,
        jsonOrNull(task.cursor),
        task.error ?? null,
        task.startedAt ?? null,
        task.finishedAt ?? null,
        task.id
      ]
    )
    this.persist()
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
      throw new Error('任务存储尚未初始化')
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

function mapTask(row: Record<string, unknown>): MigrationTask {
  return {
    id: String(row.id),
    type: String(row.type) as MigrationTask['type'],
    status: String(row.status) as MigrationTask['status'],
    connectionId: String(row.connection_id),
    payload: parseJson(row.payload) as MigrationTask['payload'],
    progress: Number(row.progress ?? 0),
    cursor: parseJson(row.cursor),
    error: nullableString(row.error),
    createdAt: String(row.created_at),
    startedAt: nullableString(row.started_at),
    finishedAt: nullableString(row.finished_at)
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value)
}

function nullableString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

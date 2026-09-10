import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

import initSqlJs from 'sql.js'
import type { SqlJsStatic } from 'sql.js'

import type {
  AgentMessage,
  AgentSession,
  AgentSessionInput
} from '../shared/types'

type SqlDatabase = InstanceType<SqlJsStatic['Database']>
type SqlStatement = InstanceType<SqlJsStatic['Statement']>

/**
 * 聊天会话 + 消息历史持久化（参考 AIIP database.py 的 conversation_history/query_history 表）
 */
export class AgentSessionStore {
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
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        llm_config_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_call_id TEXT,
        tool_name TEXT,
        tool_args TEXT,
        tool_result TEXT,
        created_at TEXT NOT NULL
      )
    `)
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_agent_messages_session
         ON agent_messages(session_id, created_at)`
    )
    this.persist()
  }

  listSessions(): AgentSession[] {
    const statement = this.prepare(
      'SELECT * FROM agent_sessions ORDER BY updated_at DESC'
    )
    const sessions: AgentSession[] = []
    while (statement.step()) {
      sessions.push(mapSession(statement.getAsObject()))
    }
    statement.free()
    return sessions
  }

  getSession(id: string): AgentSession {
    const statement = this.prepare('SELECT * FROM agent_sessions WHERE id = ?', [id])
    if (!statement.step()) {
      statement.free()
      throw new Error(`会话不存在：${id}`)
    }
    const session = mapSession(statement.getAsObject())
    statement.free()
    return session
  }

  createSession(input: AgentSessionInput): AgentSession {
    const now = new Date().toISOString()
    const session: AgentSession = {
      id: crypto.randomUUID(),
      title: input.title?.trim() || '新会话',
      llmConfigId: input.llmConfigId,
      createdAt: now,
      updatedAt: now
    }
    const db = this.requireDb()
    db.run(
      `INSERT INTO agent_sessions
        (id, title, llm_config_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        session.id,
        session.title,
        session.llmConfigId ?? null,
        session.createdAt,
        session.updatedAt
      ]
    )
    this.persist()
    return session
  }

  renameSession(id: string, title: string): AgentSession {
    const trimmed = title.trim()
    if (trimmed.length === 0) {
      throw new Error('会话标题不能为空')
    }
    const existing = this.getSession(id)
    const updatedAt = new Date().toISOString()
    const db = this.requireDb()
    db.run(
      'UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ?',
      [trimmed, updatedAt, id]
    )
    this.persist()
    return { ...existing, title: trimmed, updatedAt }
  }

  deleteSession(id: string): void {
    const db = this.requireDb()
    db.run('DELETE FROM agent_sessions WHERE id = ?', [id])
    db.run('DELETE FROM agent_messages WHERE session_id = ?', [id])
    this.persist()
  }

  touchSession(id: string): void {
    const updatedAt = new Date().toISOString()
    const db = this.requireDb()
    db.run('UPDATE agent_sessions SET updated_at = ? WHERE id = ?', [updatedAt, id])
    this.persist()
  }

  listMessages(sessionId: string): AgentMessage[] {
    const statement = this.prepare(
      `SELECT * FROM agent_messages
         WHERE session_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      [sessionId]
    )
    const messages: AgentMessage[] = []
    while (statement.step()) {
      messages.push(mapMessage(statement.getAsObject()))
    }
    statement.free()
    return messages
  }

  appendMessage(
    sessionId: string,
    role: AgentMessage['role'],
    content: string | null,
    extras: {
      toolCallId?: string
      toolName?: string
      toolArgs?: string
      toolResult?: string
    } = {}
  ): AgentMessage {
    const message: AgentMessage = {
      id: crypto.randomUUID(),
      sessionId,
      role,
      content,
      toolCallId: extras.toolCallId,
      toolName: extras.toolName,
      toolArgs: extras.toolArgs,
      toolResult: extras.toolResult,
      createdAt: new Date().toISOString()
    }
    const db = this.requireDb()
    db.run(
      `INSERT INTO agent_messages
        (id, session_id, role, content, tool_call_id, tool_name, tool_args, tool_result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        message.sessionId,
        message.role,
        message.content,
        message.toolCallId ?? null,
        message.toolName ?? null,
        message.toolArgs ?? null,
        message.toolResult ?? null,
        message.createdAt
      ]
    )
    this.touchSession(sessionId)
    this.persist()
    return message
  }

  clearMessages(sessionId: string): void {
    const db = this.requireDb()
    db.run('DELETE FROM agent_messages WHERE session_id = ?', [sessionId])
    this.touchSession(sessionId)
    this.persist()
  }

  setSessionLlmConfig(sessionId: string, llmConfigId: string | undefined): AgentSession {
    const existing = this.getSession(sessionId)
    const db = this.requireDb()
    db.run(
      'UPDATE agent_sessions SET llm_config_id = ?, updated_at = ? WHERE id = ?',
      [llmConfigId ?? null, new Date().toISOString(), sessionId]
    )
    this.persist()
    return { ...existing, llmConfigId, updatedAt: new Date().toISOString() }
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
      throw new Error('Agent 会话存储尚未初始化')
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

function mapSession(row: Record<string, unknown>): AgentSession {
  return {
    id: String(row.id),
    title: String(row.title),
    llmConfigId: nullableString(row.llm_config_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapMessage(row: Record<string, unknown>): AgentMessage {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    role: String(row.role) as AgentMessage['role'],
    content: nullableString(row.content) ?? null,
    toolCallId: nullableString(row.tool_call_id),
    toolName: nullableString(row.tool_name),
    toolArgs: nullableString(row.tool_args),
    toolResult: nullableString(row.tool_result),
    createdAt: String(row.created_at)
  }
}

function nullableString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

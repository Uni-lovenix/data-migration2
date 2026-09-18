import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

import { safeStorage } from 'electron'
import initSqlJs from 'sql.js'
import type { SqlJsStatic } from 'sql.js'

import type {
  LLMConfig,
  LLMConfigInput,
  LLMProvider,
  UpdateLLMConfigInput
} from '../shared/types'

type SqlDatabase = InstanceType<SqlJsStatic['Database']>
type SqlStatement = InstanceType<SqlJsStatic['Statement']>

export class LLMStore {
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
      CREATE TABLE IF NOT EXISTS llm_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        api_base TEXT,
        api_key_encrypted TEXT,
        model TEXT NOT NULL,
        extra_json TEXT DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    this.persist()
  }

  list(): LLMConfig[] {
    const statement = this.prepare('SELECT * FROM llm_configs ORDER BY created_at DESC')
    const configs: LLMConfig[] = []
    while (statement.step()) {
      configs.push(mapLLMConfig(statement.getAsObject()))
    }
    statement.free()
    return configs
  }

  get(id: string): LLMConfig {
    const statement = this.prepare('SELECT * FROM llm_configs WHERE id = ?', [id])
    if (!statement.step()) {
      statement.free()
      throw new Error(`LLM 配置不存在：${id}`)
    }
    const config = mapLLMConfig(statement.getAsObject())
    statement.free()
    return config
  }

  create(input: LLMConfigInput): LLMConfig {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    const apiKeyEncrypted = this.encryptKey(input.apiKey)

    const db = this.requireDb()
    db.run(
      `INSERT INTO llm_configs (
        id, name, provider, api_base, api_key_encrypted,
        model, extra_json, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.provider,
        input.apiBase ?? null,
        apiKeyEncrypted,
        input.model,
        JSON.stringify(input.extra ?? {}),
        input.enabled !== false ? 1 : 0,
        now,
        now
      ]
    )
    this.persist()
    return this.get(id)
  }

  update(id: string, input: UpdateLLMConfigInput): LLMConfig {
    const existing = this.get(id)
    const now = new Date().toISOString()

    // existing.apiKey is the masked value produced by
    // mapLLMConfig, so it cannot be reused as the raw api_key_encrypted
    // column. Read the raw ciphertext directly when the caller does not
    // supply a new apiKey.
    let preservedApiKeyEncrypted: string | null = null
    if (input.apiKey === undefined) {
      const stmt = this.prepare('SELECT api_key_encrypted FROM llm_configs WHERE id = ?', [id])
      if (stmt.step()) {
        const raw = stmt.getAsObject().api_key_encrypted
        preservedApiKeyEncrypted = typeof raw === 'string' && raw.length > 0 ? raw : null
      }
      stmt.free()
    }

    const apiKeyEncrypted =
      input.apiKey !== undefined ? this.encryptKey(input.apiKey) : preservedApiKeyEncrypted

    const db = this.requireDb()
    db.run(
      `UPDATE llm_configs SET
        name = ?, provider = ?, api_base = ?, api_key_encrypted = ?,
        model = ?, extra_json = ?, enabled = ?, updated_at = ?
      WHERE id = ?`,
      [
        input.name ?? existing.name,
        input.provider ?? existing.provider,
        (input.apiBase ?? existing.apiBase) ?? null,
        apiKeyEncrypted,
        input.model ?? existing.model,
        JSON.stringify(input.extra ?? existing.extra ?? {}),
        input.enabled !== undefined ? (input.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
        now,
        id
      ]
    )
    this.persist()
    return this.get(id)
  }

  delete(id: string): void {
    const db = this.requireDb()
    db.run('DELETE FROM llm_configs WHERE id = ?', [id])
    this.persist()
  }

  getDecryptedApiKey(id: string): string | undefined {
    const statement = this.prepare('SELECT api_key_encrypted FROM llm_configs WHERE id = ?', [id])
    if (!statement.step()) {
      statement.free()
      throw new Error(`LLM 配置不存在：${id}`)
    }
    const row = statement.getAsObject()
    statement.free()
    const encrypted = row.api_key_encrypted as string | null
    if (!encrypted) return undefined
    return this.decryptKey(encrypted)
  }

  close(): void {
    this.db?.close()
    this.db = null
  }

  private static readonly ENC_PREFIX = 'enc1:'
  private static readonly PLAIN_PREFIX = 'pln1:'

  private encryptKey(key: string | undefined): string | null {
    if (!key) return null
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(key)
      return LLMStore.ENC_PREFIX + encrypted.toString('base64')
    }
    // safeStorage not available at write time: store with a marker so the
    // read path can recognise plaintext and avoid misinterpreting it as
    // ciphertext once safeStorage becomes available.
    return LLMStore.PLAIN_PREFIX + Buffer.from(key, 'utf-8').toString('base64')
  }

  private decryptKey(stored: string): string {
    if (stored.startsWith(LLMStore.PLAIN_PREFIX)) {
      return Buffer.from(stored.slice(LLMStore.PLAIN_PREFIX.length), 'base64').toString('utf-8')
    }
    if (stored.startsWith(LLMStore.ENC_PREFIX)) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('LLM API Key 已加密，但当前会话无法访问系统密钥；请重启应用后重试')
      }
      const buffer = Buffer.from(stored.slice(LLMStore.ENC_PREFIX.length), 'base64')
      return safeStorage.decryptString(buffer)
    }
    // Legacy records (pre-prefix): best-effort recovery.
    // Historically the store wrote either base64(cipher) when safeStorage was
    // available or the raw key when it was not. Try decryptString first; on
    // failure fall back to returning the raw value so users with old
    // plaintext records are not locked out after an upgrade.
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(stored, 'base64'))
      } catch {
        return stored
      }
    }
    return stored
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
      throw new Error('LLM 存储尚未初始化')
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

function mapLLMConfig(row: Record<string, unknown>): LLMConfig {
  const apiKeyEncrypted = row.api_key_encrypted as string | null
  return {
    id: String(row.id),
    name: String(row.name),
    provider: String(row.provider) as LLMProvider,
    apiBase: nullableString(row.api_base),
    apiKey: apiKeyEncrypted ? '***masked***' : undefined,
    model: String(row.model),
    extra: parseExtra(row.extra_json),
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function parseExtra(value: unknown): Record<string, string> {
  if (typeof value !== 'string' || value.length === 0) return {}
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function nullableString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

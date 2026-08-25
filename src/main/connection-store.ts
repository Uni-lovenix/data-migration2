import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ConnectionConfig, ConnectionInput } from '../shared/types'
import { validateConnectionInput } from '../shared/validation'

interface StoredConnections {
  version: 1
  connections: ConnectionConfig[]
}

export class ConnectionStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectionStoreError'
  }
}

export class ConnectionStore {
  private readonly filePath: string
  private cache: ConnectionConfig[] = []
  private loaded = false

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async list(): Promise<ConnectionConfig[]> {
    await this.ensureLoaded()
    return this.cache.map((item) => ({ ...item }))
  }

  async get(id: string): Promise<ConnectionConfig> {
    await this.ensureLoaded()
    const connection = this.cache.find((item) => item.id === id)
    if (!connection) {
      throw new ConnectionStoreError(`连接不存在：${id}`)
    }
    return { ...connection }
  }

  async create(input: ConnectionInput): Promise<ConnectionConfig> {
    await this.ensureLoaded()
    const value = this.validateInput(input)
    const now = new Date().toISOString()
    const config: ConnectionConfig = {
      ...value,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now
    }
    this.cache.push(config)
    await this.persist()
    return { ...config }
  }

  async update(id: string, input: ConnectionInput): Promise<ConnectionConfig> {
    await this.ensureLoaded()
    const value = this.validateInput(input)
    const index = this.cache.findIndex((item) => item.id === id)
    if (index < 0) {
      throw new ConnectionStoreError(`连接不存在：${id}`)
    }

    const current = this.cache[index]
    if (!current) {
      throw new ConnectionStoreError(`连接不存在：${id}`)
    }

    const updated: ConnectionConfig = {
      ...value,
      id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString()
    }
    this.cache[index] = updated
    await this.persist()
    return { ...updated }
  }

  async delete(id: string): Promise<void> {
    await this.ensureLoaded()
    const next = this.cache.filter((item) => item.id !== id)
    if (next.length === this.cache.length) {
      throw new ConnectionStoreError(`连接不存在：${id}`)
    }
    this.cache = next
    await this.persist()
  }

  private validateInput(input: ConnectionInput): ConnectionInput {
    const result = validateConnectionInput(input)
    if (!result.ok) {
      throw new ConnectionStoreError(result.errors.join('；'))
    }
    return result.value
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return
    }

    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      this.cache = this.parseStoredConnections(parsed)
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        this.cache = []
      } else {
        throw error
      }
    }

    this.loaded = true
  }

  private parseStoredConnections(value: unknown): ConnectionConfig[] {
    if (!isStoredConnections(value)) {
      throw new ConnectionStoreError('连接配置文件格式无效')
    }
    return value.connections.map((item) => ({ ...item }))
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const payload: StoredConnections = {
      version: 1,
      connections: this.cache
    }
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.filePath)
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

function isStoredConnections(value: unknown): value is StoredConnections {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Partial<StoredConnections>
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.connections) &&
    candidate.connections.every(isConnectionConfig)
  )
}

function isConnectionConfig(value: unknown): value is ConnectionConfig {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Partial<ConnectionConfig>
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    (candidate.type === 'postgresql' || candidate.type === 'elasticsearch') &&
    typeof candidate.host === 'string' &&
    typeof candidate.port === 'number' &&
    typeof candidate.ssl === 'boolean' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.updatedAt === 'string'
  )
}

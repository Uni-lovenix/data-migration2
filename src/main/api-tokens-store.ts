import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ApiToken, ApiTokenInput, ApiTokenView } from '../shared/types'

interface StoredTokensFile {
  version: 1
  tokens: ApiToken[]
}

export class ApiTokensStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiTokensStoreError'
  }
}

export class ApiTokensStore {
  private readonly filePath: string
  private cache: ApiToken[] = []
  private loaded = false

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async list(): Promise<ApiTokenView[]> {
    await this.ensureLoaded()
    return this.cache.map(toView)
  }

  async create(input: ApiTokenInput): Promise<ApiToken> {
    await this.ensureLoaded()
    const label = input.label.trim()
    if (label.length === 0) {
      throw new ApiTokensStoreError('Token 名称不能为空')
    }
    if (this.cache.some((t) => t.label === label)) {
      throw new ApiTokensStoreError(`Token 名称已存在：${label}`)
    }
    const token: ApiToken = {
      id: randomUUID(),
      label,
      token: `dtm_${randomBytes(24).toString('hex')}`,
      masked: '',
      createdAt: new Date().toISOString()
    }
    token.masked = maskToken(token.token)
    this.cache.push(token)
    await this.persist()
    return { ...token }
  }

  async revoke(id: string): Promise<void> {
    await this.ensureLoaded()
    const before = this.cache.length
    this.cache = this.cache.filter((t) => t.id !== id)
    if (this.cache.length === before) {
      throw new ApiTokensStoreError(`Token 不存在：${id}`)
    }
    await this.persist()
  }

  async validate(rawToken: string): Promise<ApiToken | null> {
    await this.ensureLoaded()
    const found = this.cache.find((t) => t.token === rawToken)
    if (!found) return null
    // 更新最后使用时间（异步落盘，但不阻塞调用）
    found.lastUsedAt = new Date().toISOString()
    // 等待落盘完成，使调用方可在测试中观察到副作用
    await this.persist().catch(() => undefined)
    return found
  }

  async loadRawTokens(): Promise<string[]> {
    await this.ensureLoaded()
    return this.cache.map((t) => t.token)
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      this.cache = parseStored(parsed)
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        this.cache = []
      } else {
        throw error
      }
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const payload: StoredTokensFile = {
      version: 1,
      tokens: this.cache
    }
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.filePath)
  }
}

function maskToken(token: string): string {
  if (token.length <= 10) return '****'
  return `${token.slice(0, 6)}…${token.slice(-4)}`
}

function toView(token: ApiToken): ApiTokenView {
  return {
    id: token.id,
    label: token.label,
    masked: token.masked,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt
  }
}

function parseStored(value: unknown): ApiToken[] {
  if (!isStoredTokens(value)) {
    return []
  }
  return value.tokens.map((t) => ({
    ...t,
    masked: maskToken(t.token)
  }))
}

function isStoredTokens(value: unknown): value is StoredTokensFile {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<StoredTokensFile>
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.tokens) &&
    candidate.tokens.every(isToken)
  )
}

function isToken(value: unknown): value is ApiToken {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ApiToken>
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.label === 'string' &&
    typeof candidate.token === 'string' &&
    typeof candidate.createdAt === 'string'
  )
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

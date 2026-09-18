import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const safeStorageMock = {
  isEncryptionAvailable: vi.fn(),
  encryptString: vi.fn(),
  decryptString: vi.fn()
}

vi.mock('electron', () => ({
  safeStorage: safeStorageMock
}))

const { LLMStore } = await import('../src/main/llm-store')

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((d) => rm(d, { recursive: true, force: true }))
  )
  vi.clearAllMocks()
})

async function createStore(): Promise<InstanceType<typeof LLMStore>> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-store-enc-'))
  temporaryDirectories.push(dir)
  const store = new LLMStore(join(dir, 'llm.db'))
  await store.initialize()
  return store
}

function installFakeSafeStorage(opts: { available: boolean }): void {
  const keyByCipher = new Map<string, string>()
  safeStorageMock.isEncryptionAvailable.mockImplementation(() => opts.available)
  safeStorageMock.encryptString.mockImplementation((plain: string) => {
    const cipher = 'CIPHER#' + plain
    keyByCipher.set(cipher, plain)
    return Buffer.from(cipher, 'utf-8')
  })
  safeStorageMock.decryptString.mockImplementation((buf: Buffer) => {
    const cipher = buf.toString('utf-8')
    const plain = keyByCipher.get(cipher)
    if (plain === undefined) {
      throw new Error('Ciphertext does not appear to be encrypted.')
    }
    return plain
  })
}

describe('LLMStore safeStorage keystore prefix', () => {
  describe('when safeStorage is available at write time', () => {
    beforeEach(() => installFakeSafeStorage({ available: true }))

    it('encrypts API key with enc1: prefix and decrypts back', async () => {
      const store = await createStore()
      const cfg = store.create({
        name: 'openai-test',
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-secret-value'
      })
      const decrypted = store.getDecryptedApiKey(cfg.id)
      expect(decrypted).toBe('sk-secret-value')
      expect(safeStorageMock.encryptString).toHaveBeenCalledWith('sk-secret-value')
    })

    it('re-encrypts on update when apiKey is supplied', async () => {
      const store = await createStore()
      const cfg = store.create({
        name: 't',
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-old'
      })
      store.update(cfg.id, { apiKey: 'sk-new' })
      expect(store.getDecryptedApiKey(cfg.id)).toBe('sk-new')
    })

    it('keeps the stored key when update omits apiKey', async () => {
      const store = await createStore()
      const cfg = store.create({
        name: 't',
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-keep-me'
      })
      store.update(cfg.id, { model: 'gpt-4o-mini' })
      expect(store.getDecryptedApiKey(cfg.id)).toBe('sk-keep-me')
    })
  })

  describe('when safeStorage is unavailable at write time', () => {
    beforeEach(() => installFakeSafeStorage({ available: false }))

    it('stores with pln1: prefix and never calls encryptString', async () => {
      const store = await createStore()
      const cfg = store.create({
        name: 't',
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-plain-value'
      })
      expect(safeStorageMock.encryptString).not.toHaveBeenCalled()
      const decrypted = store.getDecryptedApiKey(cfg.id)
      expect(decrypted).toBe('sk-plain-value')
    })

    it('recovers a pln1: record when safeStorage becomes available later', async () => {
      const store = await createStore()
      const cfg = store.create({
        name: 't',
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-survives-state-change'
      })
      installFakeSafeStorage({ available: true })
      expect(store.getDecryptedApiKey(cfg.id)).toBe('sk-survives-state-change')
    })
  })

  describe('legacy records without prefix', () => {
    it('returns the legacy plaintext as-is when safeStorage is unavailable', async () => {
      installFakeSafeStorage({ available: false })
      const store = await createStore()
      const cfg = store.create({
        name: 't',
        provider: 'openai',
        model: 'gpt-4o'
      })
      const db = (store as unknown as { db: { exec: (sql: string) => void } }).db
      db.exec(
        'UPDATE llm_configs SET api_key_encrypted = \'sk-legacy-plain\' WHERE id = \'' + cfg.id + '\''
      )
      expect(store.getDecryptedApiKey(cfg.id)).toBe('sk-legacy-plain')
    })

    it('falls back to plaintext when decryptString rejects a legacy record', async () => {
      installFakeSafeStorage({ available: true })
      const store = await createStore()
      const cfg = store.create({
        name: 't',
        provider: 'openai',
        model: 'gpt-4o'
      })
      const db = (store as unknown as { db: { exec: (sql: string) => void } }).db
      db.exec(
        'UPDATE llm_configs SET api_key_encrypted = \'sk-another-legacy\' WHERE id = \'' + cfg.id + '\''
      )
      expect(store.getDecryptedApiKey(cfg.id)).toBe('sk-another-legacy')
    })

    it('still decrypts a legacy encrypted record when safeStorage is available', async () => {
      installFakeSafeStorage({ available: true })
      const store = await createStore()
      const cfg = store.create({
        name: 't',
        provider: 'openai',
        model: 'gpt-4o'
      })
      // Build a real cipher via the fake safeStorage so the mock map knows
      // how to invert it; then write only the base64 representation.
      const cipherBuf = safeStorageMock.encryptString('sk-legacy-cipher')
      const stored = Buffer.from(cipherBuf).toString('base64')
      const db = (store as unknown as { db: { exec: (sql: string) => void } }).db
      db.exec(
        'UPDATE llm_configs SET api_key_encrypted = \'' + stored + '\' WHERE id = \'' + cfg.id + '\''
      )
      expect(store.getDecryptedApiKey(cfg.id)).toBe('sk-legacy-cipher')
    })
  })

  describe('encrypted record read after safeStorage went away', () => {
    it('throws a clear error pointing the user at a restart', async () => {
      installFakeSafeStorage({ available: true })
      const store = await createStore()
      const cfg = store.create({
        name: 't',
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-now-encrypted'
      })
      installFakeSafeStorage({ available: false })
      expect(() => store.getDecryptedApiKey(cfg.id)).toThrow(/\u7cfb\u7edf\u5bc6\u94a5/)
    })
  })
})

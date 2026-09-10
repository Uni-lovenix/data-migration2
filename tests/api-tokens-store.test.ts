import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ApiTokensStore } from '../src/main/api-tokens-store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

async function createStore(): Promise<ApiTokensStore> {
  const directory = await mkdtemp(join(tmpdir(), 'api-tokens-test-'))
  temporaryDirectories.push(directory)
  return new ApiTokensStore(join(directory, 'tokens.json'))
}

describe('ApiTokensStore', () => {
  it('初始为空', async () => {
    const store = await createStore()
    expect(await store.list()).toEqual([])
  })

  it('创建 token 返回完整值且列表中可见', async () => {
    const store = await createStore()
    const token = await store.create({ label: 'CI' })
    expect(token.label).toBe('CI')
    expect(token.token).toMatch(/^dtm_[a-f0-9]{48}$/)
    expect(token.masked).toMatch(/^dtm_[a-f0-9]+…[a-f0-9]+$/)
    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.label).toBe('CI')
    expect(list[0]?.masked).not.toBe(token.token) // 列表中不暴露完整 token
  })

  it('空名称拒绝', async () => {
    const store = await createStore()
    await expect(store.create({ label: '' })).rejects.toThrow(/名称/)
  })

  it('重名拒绝', async () => {
    const store = await createStore()
    await store.create({ label: 'dup' })
    await expect(store.create({ label: 'dup' })).rejects.toThrow(/已存在/)
  })

  it('吊销后从列表中消失', async () => {
    const store = await createStore()
    const t = await store.create({ label: 'a' })
    await store.revoke(t.id)
    expect(await store.list()).toEqual([])
  })

  it('吊销不存在的 token 抛错', async () => {
    const store = await createStore()
    await expect(store.revoke('no-such')).rejects.toThrow(/不存在/)
  })

  it('validate 命中并更新 lastUsedAt', async () => {
    const store = await createStore()
    const t = await store.create({ label: 'used' })
    const validated = await store.validate(t.token)
    expect(validated?.id).toBe(t.id)
    expect(validated?.lastUsedAt).toBeTruthy()
  })

  it('validate 不命中返回 null', async () => {
    const store = await createStore()
    await store.create({ label: 'a' })
    const validated = await store.validate('dtm_wrong')
    expect(validated).toBeNull()
  })

  it('loadRawTokens 返回原始字符串列表', async () => {
    const store = await createStore()
    const t1 = await store.create({ label: 'a' })
    const t2 = await store.create({ label: 'b' })
    const raws = await store.loadRawTokens()
    expect(raws).toEqual(expect.arrayContaining([t1.token, t2.token]))
  })

  it('持久化：reload 后仍然可见', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'api-tokens-persist-'))
    temporaryDirectories.push(directory)
    const file = join(directory, 'tokens.json')

    const store1 = new ApiTokensStore(file)
    const t = await store1.create({ label: 'persist' })

    const store2 = new ApiTokensStore(file)
    const list = await store2.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.label).toBe('persist')
    const raws = await store2.loadRawTokens()
    expect(raws).toContain(t.token)
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ConnectionStore } from '../src/main/connection-store'
import type { ConnectionInput } from '../src/shared/types'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

function createStore(): Promise<{ store: ConnectionStore; filePath: string }> {
  return mkdtemp(join(tmpdir(), 'data-migrator-test-')).then((directory) => {
    temporaryDirectories.push(directory)
    return {
      store: new ConnectionStore(join(directory, 'connections.json')),
      filePath: join(directory, 'connections.json')
    }
  })
}

const postgresInput: ConnectionInput = {
  name: '生产 PostgreSQL',
  type: 'postgresql',
  host: 'pg.internal',
  port: 5432,
  database: 'analytics',
  ssl: true
}

describe('ConnectionStore', () => {
  it('creates, lists, updates and deletes connections', async () => {
    const { store } = await createStore()

    const created = await store.create(postgresInput)
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.createdAt).toBe(created.updatedAt)

    const listed = await store.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.name).toBe('生产 PostgreSQL')

    const updated = await store.update(created.id, {
      ...postgresInput,
      name: '生产 PostgreSQL 只读'
    })
    expect(updated.name).toBe('生产 PostgreSQL 只读')
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.updatedAt >= created.updatedAt).toBe(true)

    await store.delete(created.id)
    expect(await store.list()).toHaveLength(0)
  })

  it('persists connections to disk for the next store instance', async () => {
    const { store, filePath } = await createStore()
    const created = await store.create(postgresInput)

    const reloaded = new ConnectionStore(filePath)
    const connections = await reloaded.list()
    expect(connections).toHaveLength(1)
    expect(connections[0]?.id).toBe(created.id)
  })

  it('rejects invalid connection input', async () => {
    const { store } = await createStore()

    await expect(
      store.create({
        ...postgresInput,
        port: 99999
      })
    ).rejects.toThrow('端口必须是 1 到 65535 之间的整数')
  })

  it('rejects updates for unknown ids', async () => {
    const { store } = await createStore()

    await expect(store.update('missing-id', postgresInput)).rejects.toThrow(
      '连接不存在'
    )
  })

  it('persists a SQLite connection keyed by its database file path', async () => {
    const { store, filePath } = await createStore()
    const created = await store.create({
      name: '本地 SQLite',
      type: 'sqlite',
      host: '/tmp/app.db',
      port: 0,
      filePath: '/tmp/app.db',
      ssl: false
    })

    const reloaded = new ConnectionStore(filePath)
    await expect(reloaded.get(created.id)).resolves.toMatchObject({
      type: 'sqlite',
      filePath: '/tmp/app.db'
    })
  })
})

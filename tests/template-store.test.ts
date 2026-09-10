import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import initSqlJs from 'sql.js'

import { TemplateStore } from '../src/main/template-store'
import type { CreateTemplateInput, TemplateStep } from '../src/shared/types'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('TemplateStore', () => {
  it('creates a template with the new steps + dstConnectionName columns', async () => {
    const { store, filePath } = await createStore()

    const steps: TemplateStep[] = [
      {
        id: 'step-1',
        engine: 'pgmigrator',
        action: 'export',
        connectionName: 'pg-prod',
        configJson: '{"type":"postgres-export"}'
      },
      {
        id: 'step-2',
        engine: 'esmigrator',
        action: 'import',
        connectionName: 'es-prod',
        dstConnectionName: 'es-target',
        configJson: '{"type":"elasticsearch-import"}'
      }
    ]

    const created = store.create({
      name: 'pipeline',
      description: 'PG → ES',
      engine: 'pgmigrator',
      action: 'export',
      connectionName: 'pg-prod',
      dstConnectionName: 'es-target',
      configJson: '{"type":"postgres-export"}',
      variables: [{ name: 'DATE', defaultValue: '2026-09-10' }],
      steps
    })

    expect(created.id).toBeTruthy()
    expect(created.steps).toHaveLength(2)
    expect(created.steps[0]!.id).toBe('step-1')
    expect(created.steps[1]!.id).toBe('step-2')
    expect(created.dstConnectionName).toBe('es-target')
    expect(created.variables).toEqual([{ name: 'DATE', defaultValue: '2026-09-10' }])

    store.close()

    // Persisted across instances?
    const reloaded = new TemplateStore(filePath)
    await reloaded.initialize()
    const fetched = reloaded.get(created.id)
    expect(fetched.name).toBe('pipeline')
    expect(fetched.steps).toHaveLength(2)
    expect(fetched.steps[1]!.dstConnectionName).toBe('es-target')
    expect(fetched.variables).toEqual([{ name: 'DATE', defaultValue: '2026-09-10' }])
    reloaded.close()
  })

  it('defaults steps to [] when not provided (legacy single-task path)', async () => {
    const { store } = await createStore()
    const created = store.create(legacyInput('legacy-1'))
    expect(created.steps).toEqual([])
    expect(created.dstConnectionName).toBeUndefined()
    store.close()
  })

  it('updates steps + variables round-trip', async () => {
    const { store } = await createStore()
    const created = store.create(legacyInput('legacy-2'))

    const newSteps: TemplateStep[] = [
      {
        id: 'a',
        engine: 'esmigrator',
        action: 'export',
        connectionName: 'es',
        configJson: '{"type":"elasticsearch-export"}',
        variables: [{ name: 'INDEX', defaultValue: 'logs-*' }]
      }
    ]
    const updated = store.update(created.id, {
      steps: newSteps,
      variables: [{ name: 'DATE', defaultValue: '2026-09-10' }]
    })
    expect(updated.steps).toEqual(newSteps)
    expect(updated.variables).toEqual([{ name: 'DATE', defaultValue: '2026-09-10' }])
    store.close()
  })

  it('lists templates ordered by created_at DESC', async () => {
    // Sleep between inserts so the ISO timestamps differ at millisecond precision.
    const { store } = await createStore()
    store.create(legacyInput('a'))
    await sleep(5)
    store.create(legacyInput('b'))
    await sleep(5)
    store.create(legacyInput('c'))
    const names = store.list().map((t) => t.name)
    expect(names).toEqual(['c', 'b', 'a'])
    store.close()
  })

  it('findByName returns the first match and undefined when missing', async () => {
    const { store } = await createStore()
    store.create(legacyInput('nightly'))
    expect(store.findByName('nightly')?.name).toBe('nightly')
    expect(store.findByName('missing')).toBeUndefined()
    store.close()
  })

  it('get throws for missing id', async () => {
    const { store } = await createStore()
    expect(() => store.get('nope')).toThrow('模板不存在')
    store.close()
  })

  it('delete removes the row', async () => {
    const { store } = await createStore()
    const created = store.create(legacyInput('to-delete'))
    store.delete(created.id)
    expect(() => store.get(created.id)).toThrow('模板不存在')
    store.close()
  })

  it('migrates a legacy db without steps/dst_connection_name columns', async () => {
    // Simulate a pre-migration db: write a schema and a row that lacks the
    // new columns, then open it with TemplateStore and verify the upgrade runs
    // idempotently.
    const { filePath } = await makeStoreFile()

    const require = createRequire(import.meta.url)
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
    const SQL = await initSqlJs({ locateFile: () => wasmPath })
    const legacy = new SQL.Database()
    legacy.run(`
      CREATE TABLE templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        engine TEXT NOT NULL,
        action TEXT NOT NULL,
        connection_name TEXT NOT NULL,
        config_json TEXT NOT NULL,
        variables TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    legacy.run(
      `INSERT INTO templates (id, name, engine, action, connection_name, config_json,
        variables, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'legacy-id',
        'legacy',
        'pgmigrator',
        'export',
        'pg-prod',
        '{"type":"postgres-export"}',
        '[]',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      ]
    )
    await writeFile(filePath, Buffer.from(legacy.export()))
    legacy.close()

    const store = new TemplateStore(filePath)
    await store.initialize()
    const fetched = store.get('legacy-id')
    expect(fetched.name).toBe('legacy')
    expect(fetched.steps).toEqual([])
    expect(fetched.dstConnectionName).toBeUndefined()
    store.close()
  })

  it('initialize() is idempotent across multiple calls', async () => {
    const { store } = await createStore()
    await store.initialize()
    await store.initialize()
    // If ALTER TABLE ran a second time without the duplicate-column guard,
    // it would throw.
    const created = store.create(legacyInput('after-double-init'))
    expect(created.id).toBeTruthy()
    store.close()
  })
})

async function createStore(): Promise<{ store: TemplateStore; filePath: string }> {
  const { filePath } = await makeStoreFile()
  const store = new TemplateStore(filePath)
  await store.initialize()
  return { store, filePath }
}

async function makeStoreFile(): Promise<{ filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'data-migrator-template-store-test-'))
  temporaryDirectories.push(directory)
  return { filePath: join(directory, 'templates.db') }
}

function legacyInput(name: string): CreateTemplateInput {
  return {
    name,
    engine: 'pgmigrator',
    action: 'export',
    connectionName: 'pg-prod',
    configJson: '{"type":"postgres-export"}'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

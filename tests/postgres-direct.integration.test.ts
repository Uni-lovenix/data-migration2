import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PostgresService } from '../src/main/postgres-service'
import { RollbackConflictError } from '../src/main/task-errors'
import { readUndoJournal } from '../src/main/undo-journal'
import { RISK_NOTICE_VERSION } from '../src/shared/risk-notices'
import type {
  ConnectionConfig,
  PostgresDirectRequest,
  RollbackResult
} from '../src/shared/types'

const enabled = process.env.POSTGRES_INTEGRATION === '1'
const port = Number(process.env.POSTGRES_INTEGRATION_PORT ?? 55432)

const source: ConnectionConfig = {
  id: 'direct-source',
  name: '直连源库',
  type: 'postgresql',
  host: '127.0.0.1',
  port,
  username: 'postgres',
  password: 'secret',
  database: 'app',
  ssl: false,
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z'
}

const target: ConnectionConfig = {
  ...source,
  id: 'direct-target',
  name: '直连目标库'
}

let directory = ''
let admin: Client | null = null
const service = new PostgresService()

function riskAck(): PostgresDirectRequest['riskAck'] {
  return {
    version: RISK_NOTICE_VERSION,
    acknowledgedAt: new Date().toISOString(),
    acknowledgedBy: 'ui'
  }
}

function directRequest(
  overrides: Partial<PostgresDirectRequest> = {}
): PostgresDirectRequest {
  return {
    connectionId: source.id,
    table: { schema: 'public', name: 'direct_source' },
    targetConnectionId: target.id,
    targetTable: { schema: 'public', name: 'direct_target' },
    batchSize: 25,
    conflictPolicy: 'skip',
    rollbackOn: 'failure-or-cancel',
    riskAck: riskAck(),
    ...overrides
  }
}

beforeAll(async () => {
  if (!enabled) {
    return
  }
  directory = await mkdtemp(join(tmpdir(), 'data-migrator-direct-'))
  admin = new Client({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password: 'secret',
    database: 'app'
  })
  await admin.connect()
})

afterAll(async () => {
  if (admin) {
    await admin
      .query(
        'DROP TABLE IF EXISTS public.direct_source, public.direct_target'
      )
      .catch(() => undefined)
    await admin.end()
  }
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function resetTables(): Promise<void> {
  if (!admin) {
    return
  }
  await admin.query(`
    DROP TABLE IF EXISTS public.direct_source, public.direct_target;
    CREATE TABLE public.direct_source (
      id bigint PRIMARY KEY,
      name text NOT NULL,
      profile jsonb,
      amount numeric(12,2),
      created_at timestamptz
    );
    CREATE TABLE public.direct_target (LIKE public.direct_source INCLUDING ALL);
    INSERT INTO public.direct_source
    SELECT
      i,
      'user-' || i,
      jsonb_build_object('index', i, 'nested', jsonb_build_object('even', i % 2 = 0)),
      (i * 1.5)::numeric(12,2),
      timestamptz '2026-01-01 00:00:00+08' + (i || ' minutes')::interval
    FROM generate_series(1, 100) AS i;
  `)
}

async function countRows(table: string): Promise<number> {
  const result = await admin!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table}`
  )
  return Number(result.rows[0]?.count ?? '0')
}

describe.skipIf(!enabled)('PostgreSQL direct migration', () => {
  it('streams rows into the target and rolls the whole task back', async () => {
    await resetTables()
    const taskId = 'task-direct-1'
    const journalPath = join(directory, `${taskId}.undo.jsonl`)

    const result = await service.directMigrateTable(
      source,
      target,
      directRequest(),
      { taskId, journalPath }
    )

    expect(result.rows).toBe(100)
    expect(result.skipped).toBe(0)
    expect(result.undoJournalPath).toBe(journalPath)
    expect(await countRows('public.direct_target')).toBe(100)

    const journal = await readUndoJournal(journalPath)
    expect(journal.batches).toHaveLength(4)
    expect(journal.commits.size).toBe(4)
    expect(journal.batches[0]?.keyFields).toEqual(['id'])

    const rollback = await service.rollbackDirectMigration(target, {
      taskId,
      journalPath,
      conflictPolicy: 'abort',
      targetTable: { schema: 'public', name: 'direct_target' }
    })

    expect(rollback.deletedRows).toBe(100)
    expect(rollback.restoredRows).toBe(0)
    expect(rollback.skippedConflicts).toBe(0)
    expect(await countRows('public.direct_target')).toBe(0)

    // 幂等：重复回滚不报错也不重复计数。
    const second = await service.rollbackDirectMigration(target, {
      taskId,
      journalPath,
      conflictPolicy: 'abort',
      targetTable: { schema: 'public', name: 'direct_target' }
    })
    expect(second.deletedRows).toBe(0)
  })

  it('skips existing rows and only rolls back what this task inserted', async () => {
    await resetTables()
    if (!admin) {
      return
    }
    await admin.query(`
      INSERT INTO public.direct_target (id, name)
      SELECT i, 'pre-existing-' || i FROM generate_series(1, 40) AS i;
    `)
    const taskId = 'task-direct-2'
    const journalPath = join(directory, `${taskId}.undo.jsonl`)

    const result = await service.directMigrateTable(
      source,
      target,
      directRequest({ conflictPolicy: 'skip' }),
      { taskId, journalPath }
    )

    expect(result.rows).toBe(60)
    expect(result.skipped).toBe(40)
    expect(await countRows('public.direct_target')).toBe(100)

    const rollback = await service.rollbackDirectMigration(target, {
      taskId,
      journalPath,
      conflictPolicy: 'abort',
      targetTable: { schema: 'public', name: 'direct_target' }
    })

    expect(rollback.deletedRows).toBe(60)
    expect(await countRows('public.direct_target')).toBe(40)
    const names = await admin.query<{ name: string }>(
      'SELECT name FROM public.direct_target ORDER BY id LIMIT 1'
    )
    expect(names.rows[0]?.name).toBe('pre-existing-1')
  })

  it('restores overwritten rows to their pre-migration values', async () => {
    await resetTables()
    if (!admin) {
      return
    }
    await admin.query(`
      INSERT INTO public.direct_target (id, name, amount)
      SELECT i, 'original-' || i, 999.99 FROM generate_series(1, 50) AS i;
    `)
    const taskId = 'task-direct-3'
    const journalPath = join(directory, `${taskId}.undo.jsonl`)

    const result = await service.directMigrateTable(
      source,
      target,
      directRequest({ conflictPolicy: 'overwrite' }),
      { taskId, journalPath }
    )

    expect(result.rows).toBe(100)
    const migrated = await admin.query<{ name: string; amount: string }>(
      'SELECT name, amount FROM public.direct_target WHERE id = 1'
    )
    expect(migrated.rows[0]?.name).toBe('user-1')

    const rollback = await service.rollbackDirectMigration(target, {
      taskId,
      journalPath,
      conflictPolicy: 'abort',
      targetTable: { schema: 'public', name: 'direct_target' }
    })

    expect(rollback.deletedRows).toBe(50)
    expect(rollback.restoredRows).toBe(50)
    expect(await countRows('public.direct_target')).toBe(50)
    const restored = await admin.query<{ name: string; amount: string }>(
      'SELECT name, amount FROM public.direct_target WHERE id = 1'
    )
    expect(restored.rows[0]?.name).toBe('original-1')
    expect(Number(restored.rows[0]?.amount)).toBe(999.99)
  })

  it('detects rows changed by other writers instead of clobbering them', async () => {
    await resetTables()
    if (!admin) {
      return
    }
    const taskId = 'task-direct-4'
    const journalPath = join(directory, `${taskId}.undo.jsonl`)

    await service.directMigrateTable(
      source,
      target,
      directRequest(),
      { taskId, journalPath }
    )

    // 模拟第三方在迁移后修改了其中一行。
    await admin.query(
      `UPDATE public.direct_target SET name = 'third-party-edit' WHERE id = 7`
    )

    await expect(
      service.rollbackDirectMigration(target, {
        taskId,
        journalPath,
        conflictPolicy: 'abort',
        targetTable: { schema: 'public', name: 'direct_target' }
      })
    ).rejects.toBeInstanceOf(RollbackConflictError)
    expect(await countRows('public.direct_target')).toBe(100)

    const skipResult: RollbackResult = await service.rollbackDirectMigration(target, {
      taskId,
      journalPath,
      conflictPolicy: 'skip',
      targetTable: { schema: 'public', name: 'direct_target' }
    })
    expect(skipResult.skippedConflicts).toBe(1)
    expect(skipResult.deletedRows).toBe(99)
    const survivors = await admin.query<{ name: string }>(
      'SELECT name FROM public.direct_target WHERE id = 7'
    )
    expect(survivors.rows[0]?.name).toBe('third-party-edit')
    expect(await countRows('public.direct_target')).toBe(1)
  })

  it('does not write an undo journal when rollback is disabled', async () => {
    await resetTables()
    const taskId = 'task-direct-5'
    const journalPath = join(directory, `${taskId}.undo.jsonl`)

    const result = await service.directMigrateTable(
      source,
      target,
      directRequest({ rollbackOn: 'none' }),
      { taskId, journalPath }
    )

    expect(result.rows).toBe(100)
    expect(result.undoJournalPath).toBeUndefined()
    await expect(readUndoJournal(journalPath)).rejects.toThrow()
  })
})

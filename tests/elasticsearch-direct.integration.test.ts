import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  ElasticsearchService,
  NodeElasticsearchHttpClient
} from '../src/main/elasticsearch-service'
import { RollbackConflictError } from '../src/main/task-errors'
import { UndoJournal, readUndoJournal } from '../src/main/undo-journal'
import { RISK_NOTICE_VERSION } from '../src/shared/risk-notices'
import type {
  ConnectionConfig,
  ElasticsearchDirectRequest,
  RollbackResult
} from '../src/shared/types'

const enabled = process.env.ELASTICSEARCH_INTEGRATION === '1'
const port = Number(process.env.ELASTICSEARCH_INTEGRATION_PORT ?? 9202)
const suffix = process.pid
const sourceIndex = `dm-direct-source-${suffix}`
const targetIndex = `dm-direct-target-${suffix}`

const source: ConnectionConfig = {
  id: 'es-direct-source',
  name: 'ES 直连源',
  type: 'elasticsearch',
  host: '127.0.0.1',
  port,
  ssl: false,
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z'
}

const target: ConnectionConfig = { ...source, id: 'es-direct-target', name: 'ES 直连目标' }

let directory = ''
let client: NodeElasticsearchHttpClient | null = null
const service = new ElasticsearchService()

function riskAck(): ElasticsearchDirectRequest['riskAck'] {
  return {
    version: RISK_NOTICE_VERSION,
    acknowledgedAt: new Date().toISOString(),
    acknowledgedBy: 'ui'
  }
}

function directRequest(
  overrides: Partial<ElasticsearchDirectRequest> = {}
): ElasticsearchDirectRequest {
  return {
    connectionId: source.id,
    index: sourceIndex,
    targetConnectionId: target.id,
    targetIndex,
    batchSize: 10,
    conflictPolicy: 'skip',
    rollbackOn: 'failure-or-cancel',
    riskAck: riskAck(),
    ...overrides
  }
}

async function createIndices(): Promise<void> {
  if (!client) {
    return
  }
  await client.request({ method: 'DELETE', path: `/${sourceIndex}` }).catch(() => undefined)
  await client.request({ method: 'DELETE', path: `/${targetIndex}` }).catch(() => undefined)
  for (const index of [sourceIndex, targetIndex]) {
    await client.request({
      method: 'PUT',
      path: `/${index}`,
      body: {
        settings: { number_of_shards: 1, number_of_replicas: 0 },
        mappings: { properties: { name: { type: 'keyword' }, score: { type: 'integer' } } }
      }
    })
  }
}

async function indexDocuments(
  index: string,
  documents: Array<{ id: string; source: Record<string, unknown> }>
): Promise<void> {
  if (!client) {
    return
  }
  const lines: string[] = []
  for (const document of documents) {
    lines.push(
      JSON.stringify({ index: { _index: index, _id: document.id } }),
      JSON.stringify(document.source)
    )
  }
  await client.request({
    method: 'POST',
    path: '/_bulk?refresh=true',
    rawBody: `${lines.join('\n')}\n`
  })
}

async function fetchDoc(
  index: string,
  id: string
): Promise<{ found: boolean; source?: Record<string, unknown> }> {
  const body = (await client!.request({
    method: 'GET',
    path: `/${index}/_doc/${id}`
  })) as { body: Record<string, unknown> }
  return { found: body.body.found === true, source: body.body._source as Record<string, unknown> }
}

async function countDocs(index: string): Promise<number> {
  // bulk 写入/删除不会立即可见，先强制 refresh 再统计。
  await client!.request({ method: 'POST', path: `/${index}/_refresh` })
  const result = (await client!.request({
    method: 'POST',
    path: `/${index}/_count`,
    body: { query: { match_all: {} } }
  })) as { body: { count: number } }
  return result.body.count
}

beforeAll(async () => {
  if (!enabled) {
    return
  }
  directory = await mkdtemp(join(tmpdir(), 'data-migrator-es-direct-'))
  client = new NodeElasticsearchHttpClient(source)
})

afterAll(async () => {
  if (client) {
    await client.request({ method: 'DELETE', path: `/${sourceIndex}` }).catch(() => undefined)
    await client.request({ method: 'DELETE', path: `/${targetIndex}` }).catch(() => undefined)
  }
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe.skipIf(!enabled)('Elasticsearch direct migration', () => {
  it('streams documents into the target index and rolls the task back', async () => {
    await createIndices()
    await indexDocuments(
      sourceIndex,
      Array.from({ length: 45 }, (_, index) => ({
        id: String(index),
        source: { name: `doc-${index}`, score: index }
      }))
    )
    const taskId = 'es-direct-1'
    const journalPath = join(directory, `${taskId}.undo.jsonl`)

    const result = await service.directMigrateIndex(
      source,
      target,
      directRequest(),
      { taskId, journalPath }
    )

    expect(result.rows).toBe(45)
    expect(result.skipped).toBe(0)
    expect(await countDocs(targetIndex)).toBe(45)

    const journal = await readUndoJournal(journalPath)
    expect(journal.batches).toHaveLength(5)
    expect(journal.results.size).toBe(5)
    expect(journal.batches[0]?.engine).toBe('elasticsearch')

    const rollback = await service.rollbackDirectMigration(target, {
      taskId,
      journalPath,
      conflictPolicy: 'abort'
    })

    expect(rollback.deletedRows).toBe(45)
    expect(rollback.skippedConflicts).toBe(0)
    expect(await countDocs(targetIndex)).toBe(0)

    const second = await service.rollbackDirectMigration(target, {
      taskId,
      journalPath,
      conflictPolicy: 'abort'
    })
    expect(second.deletedRows).toBe(0)
  })

  it('keeps pre-existing documents when conflicts are skipped', async () => {
    await createIndices()
    await indexDocuments(
      sourceIndex,
      Array.from({ length: 30 }, (_, index) => ({
        id: String(index),
        source: { name: `doc-${index}`, score: index }
      }))
    )
    await indexDocuments(
      targetIndex,
      Array.from({ length: 10 }, (_, index) => ({
        id: String(index),
        source: { name: `pre-existing-${index}`, score: 999 }
      }))
    )
    const taskId = 'es-direct-2'
    const journalPath = join(directory, `${taskId}.undo.jsonl`)

    const result = await service.directMigrateIndex(
      source,
      target,
      directRequest({ conflictPolicy: 'skip' }),
      { taskId, journalPath }
    )

    expect(result.rows).toBe(20)
    expect(result.skipped).toBe(10)
    expect(await countDocs(targetIndex)).toBe(30)

    const rollback = await service.rollbackDirectMigration(target, {
      taskId,
      journalPath,
      conflictPolicy: 'abort'
    })
    expect(rollback.deletedRows).toBe(20)
    expect(await countDocs(targetIndex)).toBe(10)
    const kept = await fetchDoc(targetIndex, '0')
    expect(kept.source?.name).toBe('pre-existing-0')
  })

  it('restores overwritten documents to their previous source', async () => {
    await createIndices()
    await indexDocuments(
      sourceIndex,
      Array.from({ length: 30 }, (_, index) => ({
        id: String(index),
        source: { name: `doc-${index}`, score: index }
      }))
    )
    await indexDocuments(
      targetIndex,
      Array.from({ length: 12 }, (_, index) => ({
        id: String(index),
        source: { name: `original-${index}`, score: 777 }
      }))
    )
    const taskId = 'es-direct-3'
    const journalPath = join(directory, `${taskId}.undo.jsonl`)

    const result = await service.directMigrateIndex(
      source,
      target,
      directRequest({ conflictPolicy: 'overwrite' }),
      { taskId, journalPath }
    )
    expect(result.rows).toBe(30)
    const migrated = await fetchDoc(targetIndex, '0')
    expect(migrated.source?.name).toBe('doc-0')

    const rollback = await service.rollbackDirectMigration(target, {
      taskId,
      journalPath,
      conflictPolicy: 'abort'
    })

    expect(rollback.restoredRows).toBe(12)
    expect(rollback.deletedRows).toBe(18)
    expect(await countDocs(targetIndex)).toBe(12)
    const restored = await fetchDoc(targetIndex, '0')
    expect(restored.source?.name).toBe('original-0')
    expect(Number(restored.source?.score)).toBe(777)
  })

  it('detects documents changed by other writers', async () => {
    await createIndices()
    await indexDocuments(
      sourceIndex,
      Array.from({ length: 20 }, (_, index) => ({
        id: String(index),
        source: { name: `doc-${index}`, score: index }
      }))
    )
    const taskId = 'es-direct-4'
    const journalPath = join(directory, `${taskId}.undo.jsonl`)

    await service.directMigrateIndex(source, target, directRequest(), {
      taskId,
      journalPath
    })
    await indexDocuments(targetIndex, [
      { id: '5', source: { name: 'third-party-edit', score: 1 } }
    ])

    await expect(
      service.rollbackDirectMigration(target, {
        taskId,
        journalPath,
        conflictPolicy: 'abort'
      })
    ).rejects.toBeInstanceOf(RollbackConflictError)
    expect(await countDocs(targetIndex)).toBe(20)

    const skipped: RollbackResult = await service.rollbackDirectMigration(target, {
      taskId,
      journalPath,
      conflictPolicy: 'skip'
    })
    expect(skipped.skippedConflicts).toBe(1)
    expect(skipped.deletedRows).toBe(19)
    const survivor = await fetchDoc(targetIndex, '5')
    expect(survivor.source?.name).toBe('third-party-edit')
    expect(await countDocs(targetIndex)).toBe(1)
  })

  it('refuses to roll back a batch whose outcome was never recorded', async () => {
    await createIndices()
    const taskId = 'es-direct-5'
    const journalPath = join(directory, `${taskId}.undo.jsonl`)
    // 模拟"写入后、结果落盘前崩溃"：只有 pending 计划，没有 batch-result。
    const journal = new UndoJournal(journalPath, taskId)
    await journal.open()
    await journal.recordPendingBatch({
      engine: 'elasticsearch',
      sequence: 1,
      mode: 'insert',
      target: { schema: '', name: targetIndex },
      keyFields: ['_id'],
      keys: [],
      docs: [{ id: '1', routing: null, state: 'pending' }],
      capturedAt: new Date().toISOString()
    })
    await journal.close()
    await indexDocuments(targetIndex, [{ id: '1', source: { name: 'unknown-origin' } }])

    await expect(
      service.rollbackDirectMigration(target, {
        taskId,
        journalPath,
        conflictPolicy: 'abort'
      })
    ).rejects.toBeInstanceOf(RollbackConflictError)
    expect(await countDocs(targetIndex)).toBe(1)

    const skipped = await service.rollbackDirectMigration(target, {
      taskId,
      journalPath,
      conflictPolicy: 'skip'
    })
    expect(skipped.skippedConflicts).toBe(1)
    expect(await countDocs(targetIndex)).toBe(1)
  })

  it('does not write an undo journal when rollback is disabled', async () => {
    await createIndices()
    const taskId = 'es-direct-6'
    const journalPath = join(directory, `${taskId}.undo.jsonl`)

    const result = await service.directMigrateIndex(
      source,
      target,
      directRequest({ rollbackOn: 'none' }),
      { taskId, journalPath }
    )

    expect(result.undoJournalPath).toBeUndefined()
    await expect(readUndoJournal(journalPath)).rejects.toThrow()
  })

  it('fails fast when the target index does not exist', async () => {
    await createIndices()
    await expect(
      service.directMigrateIndex(
        source,
        target,
        directRequest({ targetIndex: `${targetIndex}-missing` }),
        { taskId: 'es-direct-7', journalPath: join(directory, 'es-direct-7.undo.jsonl') }
      )
    ).rejects.toThrow(/目标索引不存在/)
  })
})

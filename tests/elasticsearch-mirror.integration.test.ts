import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  ElasticsearchService,
  NodeElasticsearchHttpClient
} from '../src/main/elasticsearch-service'
import { RISK_NOTICE_VERSION } from '../src/shared/risk-notices'
import type {
  ConnectionConfig,
  ElasticsearchMirrorRequest
} from '../src/shared/types'

const enabled = process.env.ELASTICSEARCH_MIRROR_INTEGRATION === '1'
const sourcePort = Number(process.env.ELASTICSEARCH_INTEGRATION_PORT ?? 9202)
const targetPort = Number(process.env.ELASTICSEARCH_MIRROR_TARGET_PORT ?? 9203)
const index = `dm-mirror-${process.pid}`
const otherIndex = `dm-mirror-other-${process.pid}`

const source: ConnectionConfig = {
  id: 'mirror-source',
  name: '镜像源集群',
  type: 'elasticsearch',
  host: '127.0.0.1',
  port: sourcePort,
  ssl: false,
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z'
}

const target: ConnectionConfig = {
  ...source,
  id: 'mirror-target',
  name: '镜像目标集群',
  port: targetPort
}

let directory = ''
let sourceClient: NodeElasticsearchHttpClient | null = null
let targetClient: NodeElasticsearchHttpClient | null = null
const service = new ElasticsearchService()

function riskAck(): ElasticsearchMirrorRequest['riskAck'] {
  return {
    version: RISK_NOTICE_VERSION,
    acknowledgedAt: new Date().toISOString(),
    acknowledgedBy: 'ui'
  }
}

function mirrorRequest(
  overrides: Partial<ElasticsearchMirrorRequest> = {}
): ElasticsearchMirrorRequest {
  return {
    connectionId: source.id,
    index,
    targetConnectionId: target.id,
    batchSize: 10,
    conflictPolicy: 'skip',
    rollbackOn: 'manual',
    riskAck: riskAck(),
    ...overrides
  }
}

async function resetClusters(): Promise<void> {
  for (const [client, name] of [
    [sourceClient, index],
    [sourceClient, otherIndex],
    [targetClient, index],
    [targetClient, otherIndex]
  ] as const) {
    await client!.request({ method: 'DELETE', path: `/${name}` }).catch(() => undefined)
  }
  await sourceClient!.request({
    method: 'PUT',
    path: `/${index}`,
    body: {
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: {
        properties: {
          name: { type: 'keyword' },
          score: { type: 'integer' },
          tags: { type: 'keyword' }
        }
      },
      aliases: { [`${index}-alias`]: {} }
    }
  })
}

async function indexDocuments(
  client: NodeElasticsearchHttpClient,
  targetIndex: string,
  documents: Array<{ id: string; source: Record<string, unknown> }>
): Promise<void> {
  const lines: string[] = []
  for (const document of documents) {
    lines.push(
      JSON.stringify({ index: { _index: targetIndex, _id: document.id } }),
      JSON.stringify(document.source)
    )
  }
  await client.request({
    method: 'POST',
    path: '/_bulk?refresh=true',
    rawBody: `${lines.join('\n')}\n`
  })
}

async function countDocs(
  client: NodeElasticsearchHttpClient,
  targetIndex: string
): Promise<number> {
  await client.request({ method: 'POST', path: `/${targetIndex}/_refresh` })
  const result = (await client.request({
    method: 'POST',
    path: `/${targetIndex}/_count`,
    body: { query: { match_all: {} } }
  })) as { body: { count: number } }
  return result.body.count
}

async function indexExists(
  client: NodeElasticsearchHttpClient,
  targetIndex: string
): Promise<boolean> {
  const result = await client.request({ method: 'HEAD', path: `/${targetIndex}` })
  return result.status >= 200 && result.status < 300
}

async function mappingTypes(
  client: NodeElasticsearchHttpClient,
  targetIndex: string
): Promise<Record<string, unknown>> {
  const result = (await client.request({
    method: 'GET',
    path: `/${targetIndex}/_mapping`
  })) as { body: Record<string, { mappings: { properties: Record<string, unknown> } }> }
  return result.body[targetIndex]?.mappings?.properties ?? {}
}

beforeAll(async () => {
  if (!enabled) {
    return
  }
  directory = await mkdtemp(join(tmpdir(), 'data-migrator-es-mirror-'))
  sourceClient = new NodeElasticsearchHttpClient(source)
  targetClient = new NodeElasticsearchHttpClient(target)
})

afterAll(async () => {
  if (sourceClient && targetClient) {
    await sourceClient.request({ method: 'DELETE', path: `/${index}` }).catch(() => undefined)
    await sourceClient.request({ method: 'DELETE', path: `/${otherIndex}` }).catch(() => undefined)
    await targetClient.request({ method: 'DELETE', path: `/${index}` }).catch(() => undefined)
    await targetClient.request({ method: 'DELETE', path: `/${otherIndex}` }).catch(() => undefined)
  }
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe.skipIf(!enabled)('Elasticsearch 同索引镜像迁移', () => {
  it('creates the same-named target index and mirrors documents, then rolls back', async () => {
    await resetClusters()
    await indexDocuments(
      sourceClient!,
      index,
      Array.from({ length: 25 }, (_, i) => ({
        id: String(i),
        source: { name: `doc-${i}`, score: i, tags: ['mirror'] }
      }))
    )
    const taskId = 'mirror-1'
    const journalPath = join(directory, `${taskId}.undo.jsonl`)

    const result = await service.mirrorIndex(
      source,
      target,
      mirrorRequest(),
      { taskId, journalPath }
    )

    expect(result.targetCreated).toBe(true)
    expect(result.mappingMatched).toBe(true)
    expect(result.index).toBe(index)
    expect(result.targetIndex).toBe(index)
    expect(await indexExists(targetClient!, index)).toBe(true)
    expect(await countDocs(targetClient!, index)).toBe(25)

    // schema 被镜像：字段类型与源一致
    expect(await mappingTypes(targetClient!, index)).toEqual(
      await mappingTypes(sourceClient!, index)
    )

    const rollback = await service.rollbackDirectMigration(target, {
      taskId,
      journalPath,
      conflictPolicy: 'abort',
      dropCreatedTarget: true
    })
    expect(rollback.deletedRows).toBe(25)
    expect(await indexExists(targetClient!, index)).toBe(false)
  })

  it('copies aliases only when requested', async () => {
    await resetClusters()
    const result = await service.mirrorIndex(
      source,
      target,
      mirrorRequest({ copyAliases: true, rollbackOn: 'none' }),
      { taskId: 'mirror-2', journalPath: join(directory, 'mirror-2.undo.jsonl') }
    )
    expect(result.aliasesCopied).toEqual([`${index}-alias`])

    const aliases = (await targetClient!.request({
      method: 'GET',
      path: `/${index}/_alias`
    })) as { body: Record<string, { aliases: Record<string, unknown> }> }
    expect(Object.keys(aliases.body[index]?.aliases ?? {})).toContain(`${index}-alias`)
  })

  it('rejects a target index whose mapping differs from the source', async () => {
    await resetClusters()
    await targetClient!.request({
      method: 'PUT',
      path: `/${index}`,
      body: {
        settings: { number_of_shards: 1, number_of_replicas: 0 },
        mappings: { properties: { name: { type: 'text' }, score: { type: 'integer' } } }
      }
    })

    await expect(
      service.mirrorIndex(source, target, mirrorRequest(), {
        taskId: 'mirror-3',
        journalPath: join(directory, 'mirror-3.undo.jsonl')
      })
    ).rejects.toThrow(/结构与源不一致/)
  })

  it('skips existing documents when the target already has data', async () => {
    await resetClusters()
    await targetClient!.request({
      method: 'PUT',
      path: `/${index}`,
      body: {
        settings: { number_of_shards: 1, number_of_replicas: 0 },
        mappings: {
          properties: {
            name: { type: 'keyword' },
            score: { type: 'integer' },
            tags: { type: 'keyword' }
          }
        }
      }
    })
    await indexDocuments(
      sourceClient!,
      index,
      Array.from({ length: 10 }, (_, i) => ({
        id: String(i),
        source: { name: `doc-${i}`, score: i }
      }))
    )
    await indexDocuments(targetClient!, index, [
      { id: '0', source: { name: 'pre-existing', score: 999 } }
    ])

    const result = await service.mirrorIndex(
      source,
      target,
      mirrorRequest({ rollbackOn: 'none' }),
      { taskId: 'mirror-4', journalPath: join(directory, 'mirror-4.undo.jsonl') }
    )

    expect(result.targetCreated).toBe(false)
    expect(result.rows).toBe(9)
    expect(result.skipped).toBe(1)
    expect(await countDocs(targetClient!, index)).toBe(10)
  })

  it('reports the same index name when source and target share a cluster', async () => {
    await resetClusters()
    await indexDocuments(
      sourceClient!,
      index,
      [{ id: '1', source: { name: 'same-cluster', score: 1 } }]
    )
    const result = await service.mirrorIndex(
      source,
      source,
      mirrorRequest({ rollbackOn: 'none' }),
      { taskId: 'mirror-5', journalPath: join(directory, 'mirror-5.undo.jsonl') }
    )
    expect(result.index).toBe(index)
    expect(result.targetIndex).toBe(index)
    expect(result.skipped).toBe(1)
  })
})

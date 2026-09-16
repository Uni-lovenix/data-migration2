import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  ElasticsearchService,
  NodeElasticsearchHttpClient
} from '../src/main/elasticsearch-service'
import type { ConnectionConfig } from '../src/shared/types'

const enabled = process.env.ELASTICSEARCH_INTEGRATION === '1'
const port = Number(process.env.ELASTICSEARCH_INTEGRATION_PORT ?? 9201)
const directory = enabled ? await mkdtemp(join(tmpdir(), 'data-migrator-es-integration-')) : ''

const connection: ConnectionConfig = {
  id: 'integration-es',
  name: '集成测试 Elasticsearch',
  type: 'elasticsearch',
  host: '127.0.0.1',
  port,
  ssl: false,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z'
}

const sourceIndex = `data-migrator-es-source-${process.pid}`
const targetIndex = `data-migrator-es-target-${process.pid}`
const client = enabled ? new NodeElasticsearchHttpClient(connection) : null

afterAll(async () => {
  if (client) {
    await client
      .request({ method: 'DELETE', path: `/${sourceIndex}` })
      .catch(() => undefined)
    await client
      .request({ method: 'DELETE', path: `/${targetIndex}` })
      .catch(() => undefined)
  }
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe.skipIf(!enabled)('Elasticsearch integration', () => {
  it('exports with scroll and search_after then imports through bulk', async () => {
    if (!client) {
      return
    }
    await client.request({
      method: 'PUT',
      path: `/${sourceIndex}`,
      body: {
        settings: { number_of_shards: 2, number_of_replicas: 0 },
        mappings: {
          properties: {
            name: { type: 'keyword' },
            score: { type: 'integer' }
          }
        }
      }
    })

    const documents = Array.from({ length: 100 }, (_, index) => ({
      _id: String(index),
      _source: { name: `doc-${index}`, score: index }
    }))
    const bulkLines: string[] = []
    for (const document of documents) {
      bulkLines.push(
        JSON.stringify({ index: { _index: sourceIndex, _id: document._id } }),
        JSON.stringify(document._source)
      )
    }
    const bulkResult = await client.request({
      method: 'POST',
      path: '/_bulk',
      rawBody: `${bulkLines.join('\n')}\n`
    })
    expect(bulkResult.status).toBe(200)
    await client.request({ method: 'POST', path: '/_refresh' })

    const service = new ElasticsearchService()
    const testResult = await service.testConnection(connection)
    expect(testResult.ok).toBe(true)
    if (testResult.ok) {
      expect(Number(testResult.serverVersion?.split('.')[0])).toBeGreaterThanOrEqual(7)
      expect(testResult.supported).toBe(true)
    }

    const indices = await service.listIndices(connection)
    const source = indices.find((index) => index.name === sourceIndex)
    expect(source?.docsCount).toBe(100)
    expect(source?.fields.map((field) => field.name)).toEqual(['name', 'score'])

    const scrollFile = join(directory, 'scroll.jsonl')
    const scrollResult = await service.exportIndex(connection, {
      connectionId: connection.id,
      index: sourceIndex,
      outputFile: scrollFile,
      batchSize: 25,
      strategy: 'scroll'
    })
    expect(scrollResult.rows).toBe(100)
    expect((await readFile(scrollFile, 'utf8')).trim().split('\n')).toHaveLength(100)

    const searchAfterFile = join(directory, 'search-after.jsonl')
    const searchAfterResult = await service.exportIndex(connection, {
      connectionId: connection.id,
      index: sourceIndex,
      outputFile: searchAfterFile,
      batchSize: 20,
      strategy: 'search_after'
    })
    expect(searchAfterResult.rows).toBe(100)
    expect((await readFile(searchAfterFile, 'utf8')).trim().split('\n')).toHaveLength(100)

    await client.request({
      method: 'PUT',
      path: `/${targetIndex}`,
      body: {
        settings: { number_of_shards: 2, number_of_replicas: 0 },
        mappings: {
          properties: {
            name: { type: 'keyword' },
            score: { type: 'integer' }
          }
        }
      }
    })

    const importResult = await service.importJsonl(connection, {
      connectionId: connection.id,
      index: targetIndex,
      inputFile: scrollFile,
      batchSize: 30,
      onConflict: 'skip',
      selectedColumns: ['name']
    })
    expect(importResult.rows).toBe(100)
    expect(importResult.skipped).toBe(0)
    const projected = await client.request({
      method: 'GET',
      path: `/${targetIndex}/_doc/0`
    })
    expect(projected.body).toMatchObject({
      _source: { name: 'doc-0' }
    })
    expect(
      (projected.body as { _source?: Record<string, unknown> })._source
    ).not.toHaveProperty('score')

    const repeatResult = await service.importJsonl(connection, {
      connectionId: connection.id,
      index: targetIndex,
      inputFile: scrollFile,
      batchSize: 30,
      onConflict: 'skip',
      selectedColumns: ['name']
    })
    expect(repeatResult.rows).toBe(100)
    expect(repeatResult.skipped).toBe(100)
  }, 60_000)
})

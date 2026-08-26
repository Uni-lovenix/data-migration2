import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ElasticsearchService,
  type ElasticsearchHttpClient,
  type ElasticsearchHttpRequest,
  type ElasticsearchHttpResult
} from '../src/main/elasticsearch-service'
import type {
  ConnectionConfig,
  ElasticsearchImportRequest
} from '../src/shared/types'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

const connection: ConnectionConfig = {
  id: 'connection-es',
  name: '搜索集群',
  type: 'elasticsearch',
  host: 'localhost',
  port: 9200,
  username: 'elastic',
  password: 'secret',
  defaultIndex: 'logs',
  ssl: false,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z'
}

describe('ElasticsearchService', () => {
  it('tests a connection and reports the server version', async () => {
    const { client } = createFakeClient(() => ({
      status: 200,
      body: { version: { number: '7.10.2' } },
      text: ''
    }))
    const service = new ElasticsearchService(() => client)

    const result = await service.testConnection(connection)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.serverVersion).toBe('7.10.2')
      expect(result.supported).toBe(true)
    }
  })

  it('marks Elasticsearch versions below 7.10.2 as unsupported', async () => {
    const { client } = createFakeClient(() => ({
      status: 200,
      body: { version: { number: '7.9.0' } },
      text: ''
    }))
    const service = new ElasticsearchService(() => client)

    const result = await service.testConnection(connection)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.supported).toBe(false)
    }
  })

  it('returns a failure message when Elasticsearch cannot be reached', async () => {
    const { client } = createFakeClient(() => {
      throw new Error('connection refused')
    })
    const service = new ElasticsearchService(() => client)

    const result = await service.testConnection(connection)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('connection refused')
    }
  })

  it('lists indices with aliases and flattened mapping fields', async () => {
    const { client } = createFakeClient((request) => {
      if (request.path.startsWith('/_cat/indices')) {
        return jsonResult([
          {
            index: 'logs',
            health: 'green',
            status: 'open',
            'docs.count': '12',
            'store.size': '2.1kb'
          }
        ])
      }
      if (request.path.startsWith('/_cat/aliases')) {
        return jsonResult([{ alias: 'logs-alias', index: 'logs' }])
      }
      return jsonResult({
        logs: {
          mappings: {
            properties: {
              message: {
                type: 'text',
                fields: { keyword: { type: 'keyword' } }
              },
              created_at: { type: 'date' }
            }
          }
        }
      })
    })
    const service = new ElasticsearchService(() => client)

    const indices = await service.listIndices(connection)

    expect(indices).toHaveLength(1)
    const index = indices[0]
    expect(index?.name).toBe('logs')
    expect(index?.docsCount).toBe(12)
    expect(index?.storeSize).toBe('2.1kb')
    expect(index?.aliases).toEqual(['logs-alias'])
    expect(index?.fields.map((field) => field.name)).toEqual([
      'created_at',
      'message',
      'message.keyword'
    ])
  })

  it('exports every document with scroll and clears the scroll context', async () => {
    const directory = await makeTemporaryDirectory()
    const outputFile = join(directory, 'logs.jsonl')
    let scrollPosts = 0
    const { client, requests } = createFakeClient((request) => {
      if (request.path === '/logs/_search?scroll=1m') {
        return jsonResult({
          _scroll_id: 'scroll-1',
          hits: {
            hits: [
              { _id: '1', _source: { level: 'info' } },
              { _id: '2', _source: { level: 'warn' } }
            ]
          }
        })
      }
      if (request.path === '/_search/scroll') {
        if (request.method === 'DELETE') {
          return jsonResult({ succeeded: true })
        }
        scrollPosts += 1
        if (scrollPosts === 1) {
          return jsonResult({
            _scroll_id: 'scroll-2',
            hits: { hits: [{ _id: '3', _source: { level: 'error' } }] }
          })
        }
        return jsonResult({ _scroll_id: 'scroll-2', hits: { hits: [] } })
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`)
    })
    const service = new ElasticsearchService(() => client)
    const progress: number[] = []

    const result = await service.exportIndex(
      connection,
      {
        connectionId: connection.id,
        index: 'logs',
        outputFile,
        batchSize: 2,
        strategy: 'scroll'
      },
      (rows) => progress.push(rows)
    )

    const content = await readFile(outputFile, 'utf8')
    const lines = content.trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toEqual([
      { _id: '1', _source: { level: 'info' } },
      { _id: '2', _source: { level: 'warn' } },
      { _id: '3', _source: { level: 'error' } }
    ])
    expect(result.rows).toBe(3)
    expect(result.bytes).toBeGreaterThan(0)
    expect(progress).toEqual([2, 3])
    expect(requests.some((request) => request.method === 'DELETE')).toBe(true)
  })

  it('exports with search_after using a point in time and closes it', async () => {
    const directory = await makeTemporaryDirectory()
    const outputFile = join(directory, 'logs.jsonl')
    let searches = 0
    const { client, requests } = createFakeClient((request) => {
      if (request.path === '/logs/_pit?keep_alive=1m') {
        return jsonResult({ id: 'pit-1' })
      }
      if (request.path === '/_search') {
        searches += 1
        if (searches === 1) {
          return jsonResult({
            pit_id: 'pit-2',
            hits: {
              hits: [
                { _id: '1', _source: { seq: 1 }, sort: [1] },
                { _id: '2', _source: { seq: 2 }, sort: [2] }
              ]
            }
          })
        }
        return jsonResult({
          pit_id: 'pit-2',
          hits: { hits: [{ _id: '3', _source: { seq: 3 }, sort: [3] }] }
        })
      }
      if (request.path === '/_pit' && request.method === 'DELETE') {
        return jsonResult({ succeeded: true })
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`)
    })
    const service = new ElasticsearchService(() => client)

    const result = await service.exportIndex(connection, {
      connectionId: connection.id,
      index: 'logs',
      outputFile,
      batchSize: 2,
      strategy: 'search_after'
    })

    const content = await readFile(outputFile, 'utf8')
    const lines = content.trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toHaveLength(3)
    expect(result.rows).toBe(3)
    const secondSearch = requests.filter((request) => request.path === '/_search')[1]
    expect(secondSearch?.body).toMatchObject({ search_after: [2] })
    const deletePit = requests.find((request) => request.path === '/_pit')
    expect(deletePit?.body).toEqual({ id: 'pit-2' })
  })

  it('resumes search_after export from a stored cursor', async () => {
    const directory = await makeTemporaryDirectory()
    const outputFile = join(directory, 'logs-resumed.jsonl')
    const { client, requests } = createFakeClient((request) => {
      if (request.path === '/logs/_pit?keep_alive=1m') {
        return jsonResult({ id: 'pit-1' })
      }
      if (request.path === '/_search') {
        return jsonResult({
          pit_id: 'pit-2',
          hits: { hits: [{ _id: '3', _source: { seq: 3 }, sort: [3] }] }
        })
      }
      if (request.path === '/_pit' && request.method === 'DELETE') {
        return jsonResult({ succeeded: true })
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`)
    })
    const service = new ElasticsearchService(() => client)

    const result = await service.exportIndex(
      connection,
      {
        connectionId: connection.id,
        index: 'logs',
        outputFile,
        batchSize: 2,
        strategy: 'search_after'
      },
      undefined,
      { rows: 2, searchAfter: [2] }
    )

    const content = await readFile(outputFile, 'utf8')
    const lines = content.trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toEqual([{ _id: '3', _source: { seq: 3 } }])
    expect(result.rows).toBe(3)
    const search = requests.find((request) => request.path === '/_search')
    expect(search?.body).toMatchObject({ search_after: [2] })
  })

  it('imports JSONL documents with bulk and skips version conflicts', async () => {
    const directory = await makeTemporaryDirectory()
    const inputFile = join(directory, 'logs.jsonl')
    await writeFile(
      inputFile,
      [
        JSON.stringify({ _id: '1', _source: { level: 'info' } }),
        JSON.stringify({ _id: '2', _source: { level: 'warn' } }),
        JSON.stringify({ _id: '3', _source: { level: 'error' } })
      ].join('\n'),
      'utf8'
    )
    const bulkRequests: ElasticsearchHttpRequest[] = []
    const { client } = createFakeClient((request) => {
      if (request.path === '/_bulk') {
        bulkRequests.push(request)
        if (bulkRequests.length === 1) {
          return jsonResult({
            items: [
              { create: { status: 201 } },
              {
                create: {
                  status: 409,
                  error: {
                    type: 'version_conflict_engine_exception',
                    reason: 'document already exists'
                  }
                }
              }
            ]
          })
        }
        return jsonResult({ items: [{ create: { status: 201 } }] })
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`)
    })
    const service = new ElasticsearchService(() => client)
    const request: ElasticsearchImportRequest = {
      connectionId: connection.id,
      index: 'logs',
      inputFile,
      batchSize: 2,
      onConflict: 'skip'
    }

    const result = await service.importJsonl(connection, request)

    expect(result.rows).toBe(3)
    expect(result.skipped).toBe(1)
    expect(bulkRequests).toHaveLength(2)
    expect(bulkRequests[0]?.rawBody).toContain('"create"')
    expect(bulkRequests[0]?.rawBody).toContain('"_id":"2"')
  })

  it('fails bulk import when overwrite mode hits an indexing error', async () => {
    const directory = await makeTemporaryDirectory()
    const inputFile = join(directory, 'bad.jsonl')
    await writeFile(inputFile, JSON.stringify({ _id: '1', _source: { level: 'info' } }), 'utf8')
    const { client } = createFakeClient(() =>
      jsonResult({
        items: [
          {
            index: {
              status: 400,
              error: { type: 'mapper_parsing_exception', reason: 'failed to parse' }
            }
          }
        ]
      })
    )
    const service = new ElasticsearchService(() => client)

    await expect(
      service.importJsonl(connection, {
        connectionId: connection.id,
        index: 'logs',
        inputFile,
        batchSize: 10,
        onConflict: 'overwrite'
      })
    ).rejects.toThrow('index 操作失败')
  })
})

function jsonResult(body: unknown): ElasticsearchHttpResult {
  return {
    status: 200,
    body,
    text: JSON.stringify(body)
  }
}

function createFakeClient(
  handler: (request: ElasticsearchHttpRequest) => ElasticsearchHttpResult
): { client: ElasticsearchHttpClient; requests: ElasticsearchHttpRequest[] } {
  const requests: ElasticsearchHttpRequest[] = []
  const client: ElasticsearchHttpClient = {
    request: vi.fn(async (request: ElasticsearchHttpRequest) => {
      requests.push(request)
      return handler(request)
    })
  }
  return { client, requests }
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'data-migrator-elasticsearch-test-'))
  temporaryDirectories.push(directory)
  return directory
}

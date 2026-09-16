import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Neo4jService, normalizeNeo4jValue } from '../src/main/neo4j-service'
import type {
  Neo4jBatchExportRequest,
  Neo4jConnectionTestResult,
  Neo4jExportRequest
} from '../src/shared/types'

class FakeSession {
  records: Array<Record<string, unknown>>
  closed = false
  constructor(records: Array<Record<string, unknown>>) {
    this.records = records
  }
  async run(_query: string, _params?: Record<string, unknown>) {
    return {
      records: async function* () {
        for (const r of this.records) {
          yield r
        }
      }.bind(this)(),
      summary: () => ({})
    }
  }
  async close() {
    this.closed = true
  }
}

class FakeDriver {
  sessions: FakeSession[] = []
  closed = false
  constructor(sessions: FakeSession[]) {
    this.sessions = sessions
  }
  session(_config?: unknown): FakeSession {
    const next = this.sessions.shift()
    if (!next) throw new Error('No more fake sessions available')
    return next
  }
  async close() {
    this.closed = true
  }
}

function makeService(sessions: FakeSession[]): { service: Neo4jService; drivers: FakeDriver[] } {
  const drivers: FakeDriver[] = []
  const service = new Neo4jService((config) => {
    void config
    const driver = new FakeDriver(sessions)
    drivers.push(driver)
    return driver
  })
  return { service, drivers }
}

const baseConnection = {
  id: 'conn-1',
  name: 'test-neo4j',
  type: 'neo4j' as const,
  host: 'localhost',
  port: 7687,
  username: 'neo4j',
  password: 'test',
  database: 'neo4j',
  ssl: false,
  createdAt: '2026-09-19T00:00:00Z',
  updatedAt: '2026-09-19T00:00:00Z'
}

describe('Neo4jService', () => {
  let workdir: string
  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'neo4j-test-'))
  })
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  describe('testConnection', () => {
    it('returns ok when session.run succeeds', async () => {
      const fakeSession = new FakeSession([{ name: 'Neo4j Kernel', versions: ['5.0.0'], edition: 'community' }])
      const { service } = makeService([fakeSession])
      const result: Neo4jConnectionTestResult = await service.testConnection(baseConnection)
      expect(result.ok).toBe(true)
      expect(result.serverVersion).toBe('Neo4j')
      expect(fakeSession.closed).toBe(true)
    })

    it('returns error when session.run throws', async () => {
      const errorSession = new FakeSession([])
      errorSession.run = async () => {
        throw new Error('Neo4jError: ServiceUnavailable')
      }
      const { service } = makeService([errorSession])
      const result = await service.testConnection(baseConnection)
      expect(result.ok).toBe(false)
      expect(result.message).toContain('Neo4j')
    })
  })

  describe('listTables', () => {
    it('returns node labels and relationship types', async () => {
      const labelsSession = new FakeSession([{ label: 'Person' }, { label: 'Movie' }])
      const typesSession = new FakeSession([{ relationshipType: 'ACTED_IN' }, { relationshipType: 'DIRECTED' }])
      const { service } = makeService([labelsSession, typesSession])
      const tables = await service.listTables(baseConnection)
      expect(tables).toHaveLength(4)
      expect(tables.filter((t) => t.kind === 'node').map((t) => t.name)).toEqual(['Person', 'Movie'])
      expect(tables.filter((t) => t.kind === 'relationship').map((t) => t.name)).toEqual(['ACTED_IN', 'DIRECTED'])
      expect(labelsSession.closed).toBe(true)
      expect(typesSession.closed).toBe(true)
    })
  })

  describe('countNodes / countRelationships', () => {
    it('returns count for nodes', async () => {
      const fakeSession = new FakeSession([{ count: { low: 42, high: 0 } }])
      const { service } = makeService([fakeSession])
      const count = await service.countNodes(baseConnection, { connectionId: 'conn-1', label: 'Person' })
      expect(count).toBe(42)
    })

    it('returns count for relationships', async () => {
      const fakeSession = new FakeSession([{ count: 7 }])
      const { service } = makeService([fakeSession])
      const count = await service.countRelationships(baseConnection, { connectionId: 'conn-1', type: 'ACTED_IN' })
      expect(count).toBe(7)
    })
  })

  describe('exportTable - nodes', () => {
    it('writes PG-style JSONL envelope with node rows', async () => {
      const records = [
        { _id: { low: 1, high: 0 }, _labels: ['Person'], properties: { name: 'Alice', age: 30 } },
        { _id: { low: 2, high: 0 }, _labels: ['Person'], properties: { name: 'Bob', age: 25 } }
      ]
      const fakeSession = new FakeSession(records)
      const { service } = makeService([fakeSession])

      const request: Neo4jExportRequest = {
        connectionId: 'conn-1',
        kind: 'node',
        name: 'Person',
        outputFile: join(workdir, 'person.jsonl'),
        batchSize: 100
      }
      const result = await service.exportTable(baseConnection, request)
      expect(result.rows).toBe(2)
      expect(result.table).toEqual({ kind: 'node', name: 'Person' })

      const content = await readFile(request.outputFile, 'utf8')
      const lines = content.trim().split('\n').map((line) => JSON.parse(line))
      expect(lines).toEqual([
        { _id: 1, _labels: ['Person'], properties: { name: 'Alice', age: 30 } },
        { _id: 2, _labels: ['Person'], properties: { name: 'Bob', age: 25 } }
      ])
    })

    it('appends to .part file on resume', async () => {
      const records = [{ _id: 3, _labels: ['Person'], properties: { name: 'Carol' } }]
      const fakeSession = new FakeSession(records)
      const { service } = makeService([fakeSession])

      const request: Neo4jExportRequest = {
        connectionId: 'conn-1',
        kind: 'node',
        name: 'Person',
        outputFile: join(workdir, 'person.jsonl'),
        batchSize: 100
      }
      const result = await service.exportTable(baseConnection, request, undefined, 1)
      expect(result.rows).toBe(2) // 1 (resumed) + 1 (new)
      const fileStat = await stat(request.outputFile)
      expect(fileStat.size).toBeGreaterThan(0)
    })

    it('throws TaskCancelledError when session.run throws cancellation', async () => {
      const errorSession = new FakeSession([])
      errorSession.run = async () => {
        throw new Error('Neo4jError: Transaction canceled')
      }
      const { service } = makeService([errorSession])
      const request: Neo4jExportRequest = {
        connectionId: 'conn-1',
        kind: 'node',
        name: 'Person',
        outputFile: join(workdir, 'person.jsonl'),
        batchSize: 100
      }
      await expect(service.exportTable(baseConnection, request)).rejects.toThrow()
    })
  })

  describe('exportTable - relationships', () => {
    it('writes PG-style JSONL envelope with relationship rows', async () => {
      const records = [
        {
          _id: { low: 100, high: 0 },
          _type: 'ACTED_IN',
          _src: { low: 1, high: 0 },
          _dst: { low: 50, high: 0 },
          properties: { role: 'Neo' }
        }
      ]
      const fakeSession = new FakeSession(records)
      const { service } = makeService([fakeSession])

      const request: Neo4jExportRequest = {
        connectionId: 'conn-1',
        kind: 'relationship',
        name: 'ACTED_IN',
        outputFile: join(workdir, 'acted_in.jsonl'),
        batchSize: 100
      }
      const result = await service.exportTable(baseConnection, request)
      expect(result.rows).toBe(1)
      const content = await readFile(request.outputFile, 'utf8')
      const record = JSON.parse(content.trim())
      expect(record).toEqual({
        _id: 100,
        _type: 'ACTED_IN',
        _src: 1,
        _dst: 50,
        properties: { role: 'Neo' }
      })
    })
  })

  describe('exportTables', () => {
    it('writes one JSONL per label to outputDirectory', async () => {
      const personSession = new FakeSession([{ _id: 1, _labels: ['Person'], properties: { name: 'Alice' } }])
      const movieSession = new FakeSession([{ _id: 2, _labels: ['Movie'], properties: { title: 'Matrix' } }])
      const { service } = makeService([personSession, movieSession])

      const request: Neo4jBatchExportRequest = {
        connectionId: 'conn-1',
        kind: 'node',
        tables: ['Person', 'Movie'],
        outputDirectory: workdir,
        batchSize: 100
      }
      const result = await service.exportTables(baseConnection, request)
      expect(result.rows).toBe(2)
      expect(result.tables).toHaveLength(2)
      expect(result.tables.map((t) => t.rows)).toEqual([1, 1])
    })

    it('skips tables before resume index', async () => {
      const movieSession = new FakeSession([{ _id: 2, _labels: ['Movie'], properties: { title: 'Matrix' } }])
      const { service } = makeService([movieSession])

      const request: Neo4jBatchExportRequest = {
        connectionId: 'conn-1',
        kind: 'node',
        tables: ['Person', 'Movie'],
        outputDirectory: workdir,
        batchSize: 100
      }
      const result = await service.exportTables(baseConnection, request, undefined, { tableIndex: 1, rows: 0 })
      expect(result.rows).toBe(1)
      expect(result.tables.map((t) => t.table.name)).toEqual(['Movie'])
    })
  })

  describe('normalizeNeo4jValue', () => {
    it('passes through scalars', () => {
      expect(normalizeNeo4jValue(42)).toBe(42)
      expect(normalizeNeo4jValue('hello')).toBe('hello')
      expect(normalizeNeo4jValue(true)).toBe(true)
      expect(normalizeNeo4jValue(null)).toBe(null)
    })

    it('normalizes arrays recursively', () => {
      expect(normalizeNeo4jValue([1, 'a', true])).toEqual([1, 'a', true])
    })

    it('serializes Neo4j Date via toString', () => {
      const fakeDate = { toString: () => '2026-09-19', constructor: { name: 'Date' } }
      expect(normalizeNeo4jValue(fakeDate)).toBe('2026-09-19')
    })

    it('serializes Neo4j Duration via toString', () => {
      const fakeDuration = {
        toString: () => 'P1Y2M3DT4H',
        constructor: { name: 'Duration' }
      }
      expect(normalizeNeo4jValue(fakeDuration)).toBe('P1Y2M3DT4H')
    })

    it('extracts Neo4j Point coordinates', () => {
      const fakePoint = {
        srid: { low: 7203, high: 0 },
        x: { low: 1.5, high: 0 },
        y: { low: 2.5, high: 0 },
        z: undefined,
        constructor: { name: 'Point' }
      }
      const result = normalizeNeo4jValue(fakePoint) as Record<string, unknown>
      expect(result.srid).toBe(7203)
      expect(result.x).toBe(1.5)
      expect(result.y).toBe(2.5)
    })

    it('extracts Neo4j Node to {_id, _labels, properties}', () => {
      const fakeNode = {
        identity: { low: 5, high: 0 },
        labels: ['Person'],
        properties: { name: 'Alice' },
        constructor: { name: 'Node' }
      }
      const result = normalizeNeo4jValue(fakeNode) as Record<string, unknown>
      expect(result._id).toBe(5)
      expect(result._labels).toEqual(['Person'])
      expect(result.properties).toEqual({ name: 'Alice' })
    })

    it('extracts Neo4j Relationship to {_id, _type, _src, _dst, properties}', () => {
      const fakeRel = {
        identity: { low: 10, high: 0 },
        type: 'ACTED_IN',
        start: { low: 1, high: 0 },
        end: { low: 50, high: 0 },
        properties: { role: 'Neo' },
        constructor: { name: 'Relationship' }
      }
      const result = normalizeNeo4jValue(fakeRel) as Record<string, unknown>
      expect(result._id).toBe(10)
      expect(result._type).toBe('ACTED_IN')
      expect(result._src).toBe(1)
      expect(result._dst).toBe(50)
      expect(result.properties).toEqual({ role: 'Neo' })
    })

    it('normalizes nested objects recursively', () => {
      expect(normalizeNeo4jValue({ a: 1, b: { c: 2 } })).toEqual({ a: 1, b: { c: 2 } })
    })
  })
})

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  PostgresService,
  type PostgresClientLike
} from '../src/main/postgres-service'
import type {
  ConnectionConfig,
  PostgresImportRequest
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
  id: 'connection-1',
  name: '测试库',
  type: 'postgresql',
  host: 'localhost',
  port: 5432,
  username: 'postgres',
  password: 'secret',
  database: 'app',
  ssl: false,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z'
}

describe('PostgresService', () => {
  it('tests a connection and reports the server version', async () => {
    const fake = createFakeClient({
      query: vi.fn(async () => ({
        rows: [{ version: 'PostgreSQL 16.4 on aarch64-apple-darwin' }]
      }))
    })
    const service = new PostgresService(() => fake)

    const result = await service.testConnection(connection)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.serverVersion).toBe('16.4')
    }
    expect(fake.connect).toHaveBeenCalledTimes(1)
    expect(fake.end).toHaveBeenCalledTimes(1)
  })

  it('returns a failure message when the database cannot be reached', async () => {
    const service = new PostgresService(() =>
      createFakeClient({
        connect: vi.fn(async () => {
          throw new Error('connection refused')
        })
      })
    )

    const result = await service.testConnection(connection)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('connection refused')
    }
  })

  it('lists tables with their columns', async () => {
    const fake = createFakeClient({
      query: vi.fn(async (text: string) => {
        if (text.includes('FROM pg_class')) {
          return {
            rows: [{ schema: 'public', name: 'users', estimated_rows: 120 }]
          }
        }
        return {
          rows: [
            {
              schema: 'public',
              name: 'users',
              column_name: 'id',
              data_type: 'bigint',
              is_nullable: false,
              is_primary_key: true,
              is_generated: 'NEVER'
            },
            {
              schema: 'public',
              name: 'users',
              column_name: 'profile',
              data_type: 'jsonb',
              is_nullable: true,
              is_primary_key: false,
              is_generated: 'NEVER'
            }
          ]
        }
      })
    })
    const service = new PostgresService(() => fake)

    const tables = await service.listTables(connection)

    expect(tables).toHaveLength(1)
    const table = tables[0]
    expect(table?.schema).toBe('public')
    expect(table?.name).toBe('users')
    expect(table?.estimatedRows).toBe(120)
    expect(table?.columns).toHaveLength(2)
    expect(table?.columns[0]?.isPrimaryKey).toBe(true)
    expect(table?.columns[1]?.dataType).toBe('jsonb')
  })

  it('exports rows to a JSONL file using a streaming query', async () => {
    const directory = await makeTemporaryDirectory()
    const outputFile = join(directory, 'users.jsonl')
    const fake = createFakeClient({
      query: vi.fn((stream: unknown) => {
        if (typeof stream !== 'string') {
          return Readable.from([
            { id: 1, name: 'Alice', active: true },
            { id: 2, name: 'Bob', active: false }
          ])
        }
        throw new Error('unexpected query')
      })
    })
    const service = new PostgresService(() => fake)
    const progress: number[] = []

    const result = await service.exportTable(
      connection,
      {
        connectionId: connection.id,
        table: { schema: 'public', name: 'users' },
        outputFile,
        batchSize: 10
      },
      (rows) => progress.push(rows)
    )

    const content = await readFile(outputFile, 'utf8')
    const lines = content.trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toEqual([
      { id: 1, name: 'Alice', active: true },
      { id: 2, name: 'Bob', active: false }
    ])
    expect(result.rows).toBe(2)
    expect(result.bytes).toBeGreaterThan(0)
    expect(progress).toEqual([1, 2])
    expect(fake.end).toHaveBeenCalledTimes(1)
  })

  it('imports JSONL rows in batches', async () => {
    const directory = await makeTemporaryDirectory()
    const inputFile = join(directory, 'users.jsonl')
    await writeFile(
      inputFile,
      [
        JSON.stringify({ id: 1, name: 'Alice', profile: { role: 'admin' } }),
        JSON.stringify({ id: 2, name: 'Bob', profile: { role: 'viewer' } }),
        JSON.stringify({ id: 3, name: 'Cara', profile: { role: 'viewer' } })
      ].join('\n'),
      'utf8'
    )

    const insertQueries: Array<{ text: string; values: unknown[] }> = []
    const fake = createFakeClient({
      query: vi.fn(async (text: string, values?: unknown[]) => {
        if (text.includes('FROM information_schema.columns')) {
          return {
            rows: [
              {
                column_name: 'id',
                data_type: 'bigint',
                is_nullable: false,
                is_primary_key: true,
                is_generated: 'NEVER'
              },
              {
                column_name: 'name',
                data_type: 'text',
                is_nullable: false,
                is_primary_key: false,
                is_generated: 'NEVER'
              },
              {
                column_name: 'profile',
                data_type: 'jsonb',
                is_nullable: true,
                is_primary_key: false,
                is_generated: 'NEVER'
              }
            ]
          }
        }
        insertQueries.push({ text, values: values ?? [] })
        return { rows: [], rowCount: values?.length ?? 0 }
      })
    })
    const service = new PostgresService(() => fake)
    const request: PostgresImportRequest = {
      connectionId: connection.id,
      table: { schema: 'public', name: 'users' },
      inputFile,
      batchSize: 2,
      onConflict: 'skip'
    }

    const result = await service.importJsonl(connection, request)

    expect(result.rows).toBe(3)
    expect(insertQueries).toHaveLength(2)
    expect(insertQueries[0]?.text).toContain('ON CONFLICT DO NOTHING')
    expect(insertQueries[0]?.text).toContain('INSERT INTO "public"."users"')
    expect(insertQueries[0]?.values).toContain(JSON.stringify({ role: 'admin' }))
  })

  it('rejects rows that contain columns missing from the target table', async () => {
    const directory = await makeTemporaryDirectory()
    const inputFile = join(directory, 'bad.jsonl')
    await writeFile(inputFile, JSON.stringify({ id: 1, unknown_column: 1 }), 'utf8')
    const fake = createFakeClient({
      query: vi.fn(async (text: string) => {
        if (text.includes('FROM information_schema.columns')) {
          return {
            rows: [
              {
                column_name: 'id',
                data_type: 'bigint',
                is_nullable: false,
                is_primary_key: true,
                is_generated: 'NEVER'
              }
            ]
          }
        }
        return { rows: [], rowCount: 0 }
      })
    })
    const service = new PostgresService(() => fake)

    await expect(
      service.importJsonl(connection, {
        connectionId: connection.id,
        table: { schema: 'public', name: 'users' },
        inputFile,
        batchSize: 10,
        onConflict: 'error'
      })
    ).rejects.toThrow('目标表不存在的列')
  })

  it('resumes JSONL import from a stored line cursor', async () => {
    const directory = await makeTemporaryDirectory()
    const inputFile = join(directory, 'resume.jsonl')
    await writeFile(
      inputFile,
      [
        JSON.stringify({ id: 1, name: 'Alice' }),
        JSON.stringify({ id: 2, name: 'Bob' }),
        JSON.stringify({ id: 3, name: 'Cara' }),
        JSON.stringify({ id: 4, name: 'Dana' })
      ].join('\n'),
      'utf8'
    )

    const insertQueries: Array<{ values: unknown[] }> = []
    const fake = createFakeClient({
      query: vi.fn(async (text: string, values?: unknown[]) => {
        if (text.includes('FROM information_schema.columns')) {
          return {
            rows: [
              {
                column_name: 'id',
                data_type: 'bigint',
                is_nullable: false,
                is_primary_key: true,
                is_generated: 'NEVER'
              },
              {
                column_name: 'name',
                data_type: 'text',
                is_nullable: false,
                is_primary_key: false,
                is_generated: 'NEVER'
              }
            ]
          }
        }
        insertQueries.push({ values: values ?? [] })
        return { rows: [], rowCount: values?.length ?? 0 }
      })
    })
    const service = new PostgresService(() => fake)

    const result = await service.importJsonl(
      connection,
      {
        connectionId: connection.id,
        table: { schema: 'public', name: 'users' },
        inputFile,
        batchSize: 2,
        onConflict: 'skip'
      },
      undefined,
      { lines: 2, rows: 2 }
    )

    expect(result.rows).toBe(4)
    expect(insertQueries).toHaveLength(1)
    expect(insertQueries[0]?.values).toContain('Cara')
    expect(insertQueries[0]?.values).toContain('Dana')
  })
})

interface FakeClientOptions {
  connect?: PostgresClientLike['connect']
  end?: PostgresClientLike['end']
  query?: PostgresClientLike['query']
}

function createFakeClient(options: FakeClientOptions = {}): PostgresClientLike {
  return {
    connect: options.connect ?? vi.fn(async () => undefined),
    end: options.end ?? vi.fn(async () => undefined),
    query: options.query ?? vi.fn(async () => ({ rows: [] }))
  }
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'data-migrator-postgres-test-'))
  temporaryDirectories.push(directory)
  return directory
}

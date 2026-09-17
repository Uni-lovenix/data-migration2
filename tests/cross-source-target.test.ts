import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  PostgresService,
  type PostgresClientLike
} from '../src/main/postgres-service'
import type {
  ConnectionConfig,
  PostgresColumn,
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
  id: 'target-pg',
  name: 'PostgreSQL target',
  type: 'postgresql',
  host: 'localhost',
  port: 5432,
  username: 'postgres',
  password: 'secret',
  database: 'target',
  ssl: false,
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z'
}

const batchFormats = [
  {
    source: 'MySQL',
    line: {
      table: { schema: 'app', name: 'users' },
      columns: ['id', 'name', 'payload'],
      rows: [[1, 'Alice', { city: 'Shanghai' }]]
    }
  },
  {
    source: 'SQLite',
    line: {
      table: { schema: 'main', name: 'users' },
      columns: ['id', 'name', 'payload'],
      rows: [[2, 'Bob', { city: 'Beijing' }]]
    }
  },
  {
    source: 'Access',
    line: {
      table: { schema: 'access', name: 'Users' },
      columns: ['id', 'name', 'payload'],
      rows: [[3, 'Carol', { city: 'Shenzhen' }]]
    }
  },
  {
    source: 'Hive',
    line: {
      table: { database: 'default', name: 'users' },
      columns: ['id', 'name', 'payload'],
      rows: [[4, 'Dana', { city: 'Hangzhou' }]]
    }
  }
] as const

const batchTargetColumns: PostgresColumn[] = [
  column('id', 'integer'),
  column('name', 'text'),
  column('payload', 'text')
]

describe('cross-source JSONL compatibility', () => {
  it.each(batchFormats)(
    'imports $source batch envelopes into PostgreSQL',
    async ({ line }) => {
      const captured = await importPostgres(line, batchTargetColumns)
      expect(captured).toHaveLength(1)
      expect(captured[0]?.sql).toContain('("id", "name", "payload")')
      expect(captured[0]?.values).toEqual([
        line.rows[0][0],
        line.rows[0][1],
        JSON.stringify(line.rows[0][2])
      ])
    }
  )

  it('imports Neo4j node records into PostgreSQL with target-aware JSON fallback', async () => {
    const captured = await importPostgres(
      {
        _id: 7,
        _labels: ['User'],
        properties: { name: 'Alice', active: true }
      },
      [
        column('_id', 'integer'),
        column('_labels', 'text'),
        column('properties', 'text')
      ]
    )

    expect(captured[0]?.sql).toContain('("_id", "_labels", "properties")')
    expect(captured[0]?.values).toEqual([
      7,
      JSON.stringify(['User']),
      JSON.stringify({ name: 'Alice', active: true })
    ])
  })

  it('combines selectedColumns and fieldTransforms on a batch envelope', async () => {
    const captured = await importPostgres(
      {
        table: { schema: 'app', name: 'users' },
        columns: ['id', 'name', 'tags'],
        rows: [[1, 'Alice', ['reader', 'writer']]]
      },
      [column('id', 'integer'), column('name', 'text'), column('tags', 'text')],
      {
        selectedColumns: ['tags'],
        fieldTransforms: [
          {
            sourceColumn: 'tags',
            sourceType: 'array<string>',
            targetType: 'text',
            strategy: 'cast',
            options: { arrayDelimiter: '|' }
          }
        ]
      }
    )

    expect(captured[0]?.sql).toContain('("tags")')
    expect(captured[0]?.values).toEqual(['reader|writer'])
  })
})

async function importPostgres(
  line: unknown,
  targetColumns: PostgresColumn[],
  overrides: Partial<PostgresImportRequest> = {}
): Promise<Array<{ sql: string; values: unknown[] }>> {
  const directory = await makeTemporaryDirectory()
  const inputFile = join(directory, 'source.jsonl')
  await writeFile(inputFile, `${JSON.stringify(line)}\n`, 'utf8')
  const captured: Array<{ sql: string; values: unknown[] }> = []
  const fake = createFakeClient(targetColumns, captured)
  const service = new PostgresService(() => fake)

  await service.importJsonl(connection, {
    connectionId: connection.id,
    table: { schema: 'public', name: 'users' },
    inputFile,
    batchSize: 100,
    onConflict: 'skip',
    ...overrides
  })

  return captured.filter((entry) => entry.sql.includes('INSERT INTO'))
}

function createFakeClient(
  targetColumns: PostgresColumn[],
  captured: Array<{ sql: string; values: unknown[] }>
): PostgresClientLike {
  return {
    connect: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('information_schema.columns')) {
        return {
          rows: targetColumns.map((column) => ({
            column_name: column.name,
            data_type: column.dataType,
            is_nullable: column.isNullable,
            is_primary_key: column.isPrimaryKey,
            is_generated: column.isGenerated ? 'ALWAYS' : 'NEVER'
          }))
        }
      }
      captured.push({ sql, values: values ?? [] })
      return { rows: [], rowCount: values?.length ?? 0 }
    })
  }
}

function column(name: string, dataType: string): PostgresColumn {
  return {
    name,
    dataType,
    isNullable: false,
    isPrimaryKey: false,
    isGenerated: false
  }
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'data-migrator-cross-source-test-'))
  temporaryDirectories.push(directory)
  return directory
}

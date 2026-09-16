import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HiveService,
  hiveErrorMessage,
  type HiveQueryResult,
  type HiveSessionLike
} from '../src/main/hive-service'
import { TaskCancelledError } from '../src/main/task-errors'
import type { ConnectionConfig } from '../src/shared/types'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

const connection: ConnectionConfig = {
  id: 'connection-hive',
  name: 'Hive HTTP',
  type: 'hive',
  host: 'hive.internal',
  port: 10001,
  username: 'hive',
  password: 'secret',
  database: 'default',
  auth: 'LDAP',
  transportMode: 'http',
  httpPath: '/cliservice',
  ssl: false,
  createdAt: '2026-09-19T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z'
}

describe('HiveService with mocked HiveServer2 HTTP session', () => {
  it('lists databases, tables, versions, and exact counts', async () => {
    const session = createProtocolSession()
    const service = new HiveService(async () => session)

    await expect(service.testConnection(connection)).resolves.toMatchObject({
      ok: true,
      serverVersion: '4.0.0',
      transportMode: 'http'
    })
    await expect(service.listDatabases(connection)).resolves.toEqual([
      'default',
      'analytics'
    ])
    await expect(service.listTables(connection, 'default')).resolves.toEqual([
      { database: 'default', name: 'events' },
      { database: 'default', name: 'users' }
    ])
    await expect(
      service.countRows(connection, {
        connectionId: connection.id,
        table: { database: 'default', name: 'events' }
      })
    ).resolves.toBe(3)
  })

  it('exports paginated JSONL and JSON-encodes complex Hive values', async () => {
    const directory = await makeTemporaryDirectory()
    const outputFile = join(directory, 'events.jsonl')
    const queries: string[] = []
    const session = createProtocolSession(queries)
    const service = new HiveService(async () => session)
    const progress: number[] = []

    const result = await service.exportTable(
      connection,
      {
        connectionId: connection.id,
        table: { database: 'default', name: 'events' },
        outputFile,
        batchSize: 2
      },
      (rows) => progress.push(rows)
    )

    expect(result.rows).toBe(3)
    expect(progress).toEqual([2, 3])
    expect(queries.some((query) => query.includes('LIMIT 2 OFFSET 0'))).toBe(true)
    expect(queries.some((query) => query.includes('LIMIT 2 OFFSET 2'))).toBe(true)

    const lines = (await readFile(outputFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines).toEqual([
      {
        table: { database: 'default', name: 'events' },
        columns: ['id', 'tags', 'payload'],
        rows: [
          [1, '["a","b"]', '{"k":"v"}'],
          [2, '["c"]', '{"n":1}']
        ]
      },
      {
        table: { database: 'default', name: 'events' },
        columns: ['id', 'tags', 'payload'],
        rows: [[3, '[]', null]]
      }
    ])
  })

  it('resumes from the written row count by appending to .part', async () => {
    const directory = await makeTemporaryDirectory()
    const outputFile = join(directory, 'events.jsonl')
    const temporaryPath = `${outputFile}.part`
    await writeFile(
      temporaryPath,
      `${JSON.stringify({
        table: { database: 'default', name: 'events' },
        columns: ['id', 'tags', 'payload'],
        rows: [
          [1, '["a","b"]', '{"k":"v"}'],
          [2, '["c"]', '{"n":1}']
        ]
      })}\n`,
      'utf8'
    )
    const queries: string[] = []
    const service = new HiveService(async () => createProtocolSession(queries))

    const result = await service.exportTable(
      connection,
      {
        connectionId: connection.id,
        table: { database: 'default', name: 'events' },
        outputFile,
        batchSize: 10
      },
      undefined,
      2
    )

    expect(result.rows).toBe(3)
    expect(queries.some((query) => query.includes('LIMIT 10 OFFSET 2'))).toBe(true)
    const lines = (await readFile(outputFile, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    await expect(stat(temporaryPath)).rejects.toThrow()
  })

  it('stops at the committed page when cancellation is signalled', async () => {
    const directory = await makeTemporaryDirectory()
    const outputFile = join(directory, 'events.jsonl')
    const service = new HiveService(async () => createProtocolSession())

    await expect(
      service.exportTable(
        connection,
        {
          connectionId: connection.id,
          table: { database: 'default', name: 'events' },
          outputFile,
          batchSize: 2
        },
        () => {
          throw new TaskCancelledError('task-1')
        }
      )
    ).rejects.toBeInstanceOf(TaskCancelledError)

    const line = JSON.parse((await readFile(`${outputFile}.part`, 'utf8')).trim())
    expect(line.rows).toHaveLength(2)
  })

  it('classifies authentication and connection-refused diagnostics', () => {
    expect(
      hiveErrorMessage(
        Object.assign(new Error('Invalid credentials'), { name: 'AuthenticationError' }),
        connection
      )
    ).toContain('Authentication failed')
    expect(
      hiveErrorMessage(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        connection
      )
    ).toContain('Connection refused: hive.internal:10001')
  })

  it('imports JSONL with one multi-row INSERT and JSON string conversion', async () => {
    const directory = await makeTemporaryDirectory()
    const inputFile = join(directory, 'events.jsonl')
    await writeFile(
      inputFile,
      JSON.stringify({
        table: { database: 'default', name: 'events' },
        columns: ['id', 'name', 'active'],
        rows: [[1, 'Alice', true], [2, 'Bob', false]]
      }) + '\n',
      'utf8'
    )
    const { session, statements } = createWritableProtocolSession()
    const service = new HiveService(async () => session)

    const result = await service.importJsonl(connection, {
      connectionId: connection.id,
      table: { database: 'default', name: 'events' },
      inputFile,
      batchSize: 100
    })

    expect(result.rows).toBe(2)
    expect(result.skipped).toBe(0)
    const inserts = statements.filter((statement) => statement.startsWith('INSERT INTO'))
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toContain('VALUES (1, \'Alice\', true), (2, \'Bob\', false)')
  })

  it('skips rows that fail target type conversion with line diagnostics', async () => {
    const directory = await makeTemporaryDirectory()
    const inputFile = join(directory, 'events.jsonl')
    await writeFile(
      inputFile,
      JSON.stringify({
        table: { database: 'default', name: 'events' },
        columns: ['id', 'name', 'active'],
        rows: [[3, 'Carol', true], [4, 'Bad', 'not-a-bool']]
      }) + '\n',
      'utf8'
    )
    const { session, statements } = createWritableProtocolSession()
    const service = new HiveService(async () => session)

    const result = await service.importJsonl(connection, {
      connectionId: connection.id,
      table: { database: 'default', name: 'events' },
      inputFile,
      batchSize: 100
    })

    expect(result.rows).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.warnings?.join('\n')).toContain('第 1 行')
    expect(result.warnings?.join('\n')).toContain('active')
    const inserts = statements.filter((statement) => statement.startsWith('INSERT INTO'))
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toContain('(3, \'Carol\', true)')
    expect(inserts[0]).not.toContain('Bad')
  })

  it('skips resumed JSONL lines and stops at a committed batch on cancel', async () => {
    const directory = await makeTemporaryDirectory()
    const inputFile = join(directory, 'events.jsonl')
    await writeFile(
      inputFile,
      [
        JSON.stringify({ id: 1, name: 'Alice', active: true }),
        JSON.stringify({ id: 2, name: 'Bob', active: false }),
        JSON.stringify({ id: 3, name: 'Carol', active: true })
      ].join('\n') + '\n',
      'utf8'
    )
    const { session, statements } = createWritableProtocolSession()
    const service = new HiveService(async () => session)

    const resumed = await service.importJsonl(
      connection,
      {
        connectionId: connection.id,
        table: { database: 'default', name: 'events' },
        inputFile,
        batchSize: 100
      },
      undefined,
      { lines: 2, rows: 2 }
    )
    expect(resumed.rows).toBe(3)
    expect(statements.filter((statement) => statement.startsWith('INSERT INTO'))).toHaveLength(1)
    expect(statements.at(-1)).toContain("(3, 'Carol', true)")

    statements.length = 0
    await expect(
      service.importJsonl(
        connection,
        {
          connectionId: connection.id,
          table: { database: 'default', name: 'events' },
          inputFile,
          batchSize: 1
        },
        () => {
          throw new TaskCancelledError('task-1')
        }
      )
    ).rejects.toBeInstanceOf(TaskCancelledError)
    expect(statements.filter((statement) => statement.startsWith('INSERT INTO'))).toHaveLength(1)
  })
})

function createProtocolSession(queries: string[] = []): HiveSessionLike & {
  close: ReturnType<typeof vi.fn>
} {
  return {
    async query(statement: string): Promise<HiveQueryResult> {
      queries.push(statement)
      if (statement.includes('version()')) {
        return { columns: ['version'], rows: [{ version: '4.0.0' }] }
      }
      if (statement === 'SHOW DATABASES') {
        return {
          columns: ['database_name'],
          rows: [{ database_name: 'default' }, { database_name: 'analytics' }]
        }
      }
      if (statement.includes('SHOW TABLES IN')) {
        return {
          columns: ['tab_name'],
          rows: [{ tab_name: 'events' }, { tab_name: 'users' }]
        }
      }
      if (statement.includes('COUNT(1)')) {
        return { columns: ['count'], rows: [{ count: 3 }] }
      }
      if (statement.includes('LIMIT 0')) {
        return {
          columns: ['id', 'tags', 'payload'],
          rows: []
        }
      }

      const offset = Number(statement.match(/OFFSET (\d+)/)?.[1] ?? 0)
      const limit = Number(statement.match(/LIMIT (\d+)/)?.[1] ?? 2)
      const allRows = [
        { id: 1, tags: ['a', 'b'], payload: { k: 'v' } },
        { id: 2, tags: ['c'], payload: { n: 1 } },
        { id: 3, tags: [], payload: null }
      ]
      return {
        columns: ['id', 'tags', 'payload'],
        rows: allRows.slice(offset, offset + limit)
      }
    },
    close: vi.fn(async () => undefined)
  }
}

function createWritableProtocolSession(): {
  session: HiveSessionLike
  statements: string[]
} {
  const statements: string[] = []
  return {
    statements,
    session: {
      async query(statement: string): Promise<HiveQueryResult> {
        statements.push(statement)
        if (statement.startsWith('DESCRIBE')) {
          return {
            columns: ['col_name', 'data_type', 'comment'],
            rows: [
              { col_name: 'id', data_type: 'int', comment: '' },
              { col_name: 'name', data_type: 'string', comment: '' },
              { col_name: 'active', data_type: 'boolean', comment: '' }
            ]
          }
        }
        if (statement.startsWith('INSERT INTO')) {
          return { columns: [], rows: [] }
        }
        return { columns: [], rows: [] }
      },
      close: async () => undefined
    }
  }
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'data-migrator-hive-test-'))
  temporaryDirectories.push(directory)
  return directory
}

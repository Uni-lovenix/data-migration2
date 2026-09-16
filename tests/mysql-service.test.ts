import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MySQLService,
  mysqlErrorMessage,
  type MySQLClientLike,
  type MySQLQueryResultRow,
  type MySQLRowStream
} from '../src/main/mysql-service'
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
  id: 'connection-my',
  name: 'MySQL 生产库',
  type: 'mysql',
  host: 'localhost',
  port: 3306,
  username: 'root',
  password: 'secret',
  database: 'app',
  ssl: false,
  createdAt: '2026-09-19T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z'
}

describe('MySQLService', () => {
  it('tests a connection and reports the server version', async () => {
    const fake = createFakeClient({
      query: vi.fn(async () => [{ version: '8.0.36' }])
    })
    const service = new MySQLService(() => fake)

    const result = await service.testConnection(connection)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.serverVersion).toBe('8.0.36')
    }
    expect(fake.connect).toHaveBeenCalledTimes(1)
    expect(fake.end).toHaveBeenCalledTimes(1)
  })

  it('returns a readable failure message when the database cannot be reached', async () => {
    const service = new MySQLService(() =>
      createFakeClient({
        connect: vi.fn(async () => {
          throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), {
            code: 'ECONNREFUSED'
          })
        })
      })
    )

    const result = await service.testConnection(connection)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('ECONNREFUSED')
      expect(result.message).toContain('连接被拒绝')
    }
  })

  it('keeps the errno code when Access is denied', () => {
    const message = mysqlErrorMessage(
      {
        code: 'ER_ACCESS_DENIED_ERROR',
        sqlMessage: "Access denied for user 'root'@'localhost'"
      },
      connection
    )
    expect(message).toContain('Access denied')
    expect(message).toContain('[ER_ACCESS_DENIED_ERROR]')
  })

  it('lists databases', async () => {
    const fake = createFakeClient({
      query: vi.fn(async () => [{ name: 'app' }, { name: 'analytics' }])
    })
    const service = new MySQLService(() => fake)

    const databases = await service.listDatabases(connection)

    expect(databases).toEqual(['app', 'analytics'])
  })

  it('lists tables with grouped column metadata', async () => {
    const fake = createFakeClient({
      query: vi.fn(async (text: string) => {
        if (text.includes('FROM information_schema.TABLES')) {
          return [{ name: 'users', estimated_rows: 120 }]
        }
        if (text.includes('FROM information_schema.COLUMNS')) {
          return [
            {
              name: 'users',
              column_name: 'id',
              data_type: 'bigint',
              is_nullable: 'NO',
              column_key: 'PRI',
              extra: ''
            },
            {
              name: 'users',
              column_name: 'payload',
              data_type: 'json',
              is_nullable: 'YES',
              column_key: '',
              extra: ''
            }
          ]
        }
        return []
      })
    })
    const service = new MySQLService(() => fake)

    const tables = await service.listTables(connection, 'app')

    expect(tables).toHaveLength(1)
    const table = tables[0]
    expect(table?.schema).toBe('app')
    expect(table?.name).toBe('users')
    expect(table?.estimatedRows).toBe(120)
    expect(table?.columns).toHaveLength(2)
    expect(table?.columns[0]?.isPrimaryKey).toBe(true)
    expect(table?.columns[1]?.dataType).toBe('json')
  })

  it('counts rows with count(1)', async () => {
    const fake = createFakeClient({
      query: vi.fn(async (text: string) => {
        if (text.includes('COUNT(1)')) {
          return [{ count: '3' }]
        }
        return []
      })
    })
    const service = new MySQLService(() => fake)

    const count = await service.countRows(connection, {
      connectionId: connection.id,
      table: { schema: 'app', name: 'users' },
      database: 'app'
    })

    expect(count).toBe(3)
  })

  it('streams rows into a JSONL file with the shared envelope', async () => {
    const directory = await makeTemporaryDirectory()
    const outputFile = join(directory, 'users.jsonl')
    const fake = createFakeClient({
      query: vi.fn(async (text: string) => {
        if (text.includes('FROM information_schema.COLUMNS')) {
          return [
            {
              column_name: 'id',
              data_type: 'bigint',
              is_nullable: 'NO',
              column_key: 'PRI',
              extra: ''
            },
            {
              column_name: 'name',
              data_type: 'varchar(255)',
              is_nullable: 'YES',
              column_key: '',
              extra: ''
            }
          ]
        }
        return []
      }),
      stream: vi.fn(() =>
        Readable.from([
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' }
        ])
      ) as unknown as MySQLClientLike['stream']
    })
    const service = new MySQLService(() => fake)
    const progress: number[] = []

    const result = await service.exportTable(
      connection,
      {
        connectionId: connection.id,
        table: { schema: 'app', name: 'users' },
        outputFile,
        batchSize: 10,
        database: 'app'
      },
      (rows) => progress.push(rows)
    )

    const content = await readFile(outputFile, 'utf8')
    const lines = content.trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toEqual([
      {
        table: { schema: 'app', name: 'users' },
        columns: ['id', 'name'],
        rows: [[1, 'Alice'], [2, 'Bob']]
      }
    ])
    expect(result.rows).toBe(2)
    expect(result.bytes).toBeGreaterThan(0)
    expect(progress).toEqual([2])
    expect(fake.end).toHaveBeenCalledTimes(1)
  })

  it('resumes from the written row count with LIMIT/OFFSET and appends to .part', async () => {
    const directory = await makeTemporaryDirectory()
    const outputFile = join(directory, 'users.jsonl')
    const temporaryPath = `${outputFile}.part`
    await writeFile(
      temporaryPath,
      `${JSON.stringify({
        table: { schema: 'app', name: 'users' },
        columns: ['id', 'name'],
        rows: [[1, 'Alice']]
      })}\n`,
      'utf8'
    )

    const observedSql: string[] = []
    const fake = createFakeClient({
      query: vi.fn(async (text: string) => {
        if (text.includes('FROM information_schema.COLUMNS')) {
          return [
            {
              column_name: 'id',
              data_type: 'bigint',
              is_nullable: 'NO',
              column_key: 'PRI',
              extra: ''
            },
            {
              column_name: 'name',
              data_type: 'varchar(255)',
              is_nullable: 'YES',
              column_key: '',
              extra: ''
            }
          ]
        }
        return []
      }),
      stream: vi.fn((sql: string) => {
        observedSql.push(sql)
        return Readable.from([{ id: 2, name: 'Bob' }])
      }) as unknown as MySQLClientLike['stream']
    })
    const service = new MySQLService(() => fake)

    const result = await service.exportTable(
      connection,
      {
        connectionId: connection.id,
        table: { schema: 'app', name: 'users' },
        outputFile,
        batchSize: 10,
        database: 'app'
      },
      undefined,
      500
    )

    expect(observedSql[0]).toContain('ORDER BY `id`')
    expect(observedSql[0]).toContain('OFFSET 500')
    const content = await readFile(outputFile, 'utf8')
    const lines = content.trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toHaveLength(2)
    expect(lines[1]?.rows).toEqual([[2, 'Bob']])
    expect(result.rows).toBe(501)
    await expect(stat(temporaryPath)).rejects.toThrow()
  })

  it('stops the cursor and keeps the .part file when a cancel is signalled', async () => {
    const directory = await makeTemporaryDirectory()
    const outputFile = join(directory, 'users.jsonl')
    const fake = createFakeClient({
      query: vi.fn(async (text: string) => {
        if (text.includes('FROM information_schema.COLUMNS')) {
          return [
            {
              column_name: 'id',
              data_type: 'bigint',
              is_nullable: 'NO',
              column_key: 'PRI',
              extra: ''
            }
          ]
        }
        return []
      }),
      stream: vi.fn(() =>
        Readable.from([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])
      ) as unknown as MySQLClientLike['stream']
    })
    const service = new MySQLService(() => fake)

    await expect(
      service.exportTable(
        connection,
        {
          connectionId: connection.id,
          table: { schema: 'app', name: 'users' },
          outputFile,
          batchSize: 2,
          database: 'app'
        },
        () => {
          throw new TaskCancelledError('task-1')
        }
      )
    ).rejects.toBeInstanceOf(TaskCancelledError)

    await expect(stat(`${outputFile}.part`)).resolves.toBeDefined()
  })

  it('exports multiple tables to separate JSONL files', async () => {
    const directory = await makeTemporaryDirectory()
    const fake = createFakeClient({
      query: vi.fn(async (text: string) => {
        if (text.includes('FROM information_schema.COLUMNS')) {
          return [
            {
              column_name: 'id',
              data_type: 'bigint',
              is_nullable: 'NO',
              column_key: 'PRI',
              extra: ''
            }
          ]
        }
        return []
      }),
      stream: vi.fn(() => Readable.from([{ id: 1 }])) as unknown as MySQLClientLike['stream']
    })
    const service = new MySQLService(() => fake)

    const result = await service.exportTables(connection, {
      connectionId: connection.id,
      tables: [
        { schema: 'app', name: 'users' },
        { schema: 'app', name: 'orders' }
      ],
      outputDirectory: directory,
      batchSize: 10,
      database: 'app'
    })

    expect(result.rows).toBe(2)
    expect(result.tables).toHaveLength(2)
    await expect(stat(join(directory, 'app.users.jsonl'))).resolves.toBeDefined()
    await expect(stat(join(directory, 'app.orders.jsonl'))).resolves.toBeDefined()
  })
})

describe('MySQLService.importJsonl', () => {
  it('imports rows with INSERT and respects row-aligned resume lines', async () => {
    const directory = await makeTemporaryDirectory()
    const inputFile = join(directory, 'orders.jsonl')
    await writeFile(
      inputFile,
      [
        JSON.stringify({
          table: { schema: 'app', name: 'orders' },
          columns: ['id', 'name'],
          rows: [[1, 'Alice'], [2, 'Bob']]
        })
      ].join('\n') + '\n',
      'utf8'
    )

    const captured: Array<{ sql: string; values: unknown[] }> = []
    const fake = createFakeClient({
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes('FROM information_schema.COLUMNS')) {
          return [
            {
              column_name: 'id',
              data_type: 'bigint',
              is_nullable: 'NO',
              column_key: 'PRI',
              extra: ''
            },
            {
              column_name: 'name',
              data_type: 'varchar(255)',
              is_nullable: 'YES',
              column_key: '',
              extra: ''
            }
          ]
        }
        captured.push({ sql, values: values ?? [] })
        return []
      }) as FakeClientOptions['query']
    })
    const service = new MySQLService(() => fake)

    const result = await service.importJsonl(connection, {
      connectionId: connection.id,
      table: { schema: 'app', name: 'orders' },
      inputFile,
      batchSize: 100,
      onConflict: 'error',
      database: 'app'
    })

    expect(result.rows).toBe(2)
    const inserts = captured.filter((c) => c.sql.includes('INSERT INTO'))
    expect(inserts.length).toBe(1)
    // 同一 JSONL 批次信封展开后，应通过一条多值 INSERT 批量写入。
    expect(inserts[0]?.sql).toContain('INSERT INTO `app`.`orders`')
    expect(inserts[0]?.sql).toContain('(`id`, `name`)')
    expect(inserts[0]?.sql).toContain('VALUES (?, ?), (?, ?)')
    expect(inserts[0]?.sql).not.toContain('IGNORE')
    expect(inserts[0]?.sql).not.toContain('ON DUPLICATE KEY UPDATE')
    expect(inserts[0]?.values).toEqual([1, 'Alice', 2, 'Bob'])
  })

  it('emits INSERT IGNORE for skip and ON DUPLICATE KEY UPDATE for update', async () => {
    const directory = await makeTemporaryDirectory()
    const insertStatements: string[] = []
    const writeStatements = async (onConflict: 'error' | 'skip' | 'update'): Promise<void> => {
      const inputFile = join(directory, `${onConflict}.jsonl`)
      await writeFile(
        inputFile,
        JSON.stringify({
          table: { schema: 'app', name: 'orders' },
          columns: ['id', 'name'],
          rows: [[1, 'Alice']]
        }) + '\n',
        'utf8'
      )
      const captured: string[] = []
      const fake = createFakeClient({
        query: vi.fn(async (sql: string) => {
          if (sql.includes('FROM information_schema.COLUMNS')) {
            return [
              {
                column_name: 'id',
                data_type: 'bigint',
                is_nullable: 'NO',
                column_key: 'PRI',
                extra: ''
              },
              {
                column_name: 'name',
                data_type: 'varchar(255)',
                is_nullable: 'YES',
                column_key: '',
                extra: ''
              }
            ]
          }
          captured.push(sql)
          return []
        }) as FakeClientOptions['query']
      })
      const service = new MySQLService(() => fake)
      await service.importJsonl(connection, {
        connectionId: connection.id,
        table: { schema: 'app', name: 'orders' },
        inputFile,
        batchSize: 100,
        onConflict,
        database: 'app'
      })
      const insert = captured.find((s) => s.includes('INSERT'))
      if (insert) insertStatements.push(insert)
    }

    await writeStatements('error')
    await writeStatements('skip')
    await writeStatements('update')

    expect(insertStatements[0]).not.toContain('IGNORE')
    expect(insertStatements[0]).not.toContain('ON DUPLICATE KEY UPDATE')
    expect(insertStatements[1]).toContain('INSERT IGNORE INTO')
    expect(insertStatements[1]).not.toContain('ON DUPLICATE KEY UPDATE')
    expect(insertStatements[2]).toContain('INSERT INTO')
    expect(insertStatements[2]).toContain('ON DUPLICATE KEY UPDATE')
    expect(insertStatements[2]).toContain('`id` = VALUES(`id`)')
    expect(insertStatements[2]).toContain('`name` = VALUES(`name`)')
  })

  it('lists missing target columns and skips the insert', async () => {
    const directory = await makeTemporaryDirectory()
    const inputFile = join(directory, 'orders.jsonl')
    await writeFile(
      inputFile,
      JSON.stringify({
        table: { schema: 'app', name: 'orders' },
        columns: ['id', 'name', 'extra'],
        rows: [[1, 'Alice', 'x']]
      }) + '\n',
      'utf8'
    )

    const insertCalls: string[] = []
    const fake = createFakeClient({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM information_schema.COLUMNS')) {
          return [
            {
              column_name: 'id',
              data_type: 'bigint',
              is_nullable: 'NO',
              column_key: 'PRI',
              extra: ''
            },
            {
              column_name: 'name',
              data_type: 'varchar(255)',
              is_nullable: 'YES',
              column_key: '',
              extra: ''
            }
          ]
        }
        insertCalls.push(sql)
        return []
      }) as FakeClientOptions['query']
    })
    const service = new MySQLService(() => fake)

    await expect(
      service.importJsonl(connection, {
        connectionId: connection.id,
        table: { schema: 'app', name: 'orders' },
        inputFile,
        batchSize: 100,
        onConflict: 'error',
        database: 'app'
      })
    ).rejects.toThrow(/缺失列.*extra.*第 1 行/)

    expect(insertCalls.some((sql) => sql.includes('INSERT INTO'))).toBe(false)
  })

  it('skips already-resumed lines and does not advance cursor on write failure', async () => {
    const directory = await makeTemporaryDirectory()
    const inputFile = join(directory, 'orders.jsonl')
    await writeFile(
      inputFile,
      [
        JSON.stringify({ id: 1, name: 'Alice' }),
        JSON.stringify({ id: 2, name: 'Bob' }),
        JSON.stringify({ id: 3, name: 'Carol' })
      ].join('\n') + '\n',
      'utf8'
    )

    const inserts: string[] = []
    const fake = createFakeClient({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM information_schema.COLUMNS')) {
          return [
            {
              column_name: 'id',
              data_type: 'bigint',
              is_nullable: 'NO',
              column_key: 'PRI',
              extra: ''
            },
            {
              column_name: 'name',
              data_type: 'varchar(255)',
              is_nullable: 'YES',
              column_key: '',
              extra: ''
            }
          ]
        }
        inserts.push(sql)
        return []
      }) as FakeClientOptions['query']
    })
    const service = new MySQLService(() => fake)

    // resume: skip first 2 lines, count already at 2
    const result = await service.importJsonl(
      connection,
      {
        connectionId: connection.id,
        table: { schema: 'app', name: 'orders' },
        inputFile,
        batchSize: 100,
        onConflict: 'error',
        database: 'app'
      },
      undefined,
      { lines: 2, rows: 2 }
    )

    expect(result.rows).toBe(3) // 2 from resume + 1 newly imported
    expect(inserts.some((s) => s.includes('INSERT INTO'))).toBe(true)
    const insert = inserts.find((s) => s.includes('INSERT INTO'))
    // 1 row inserted (Carol)
    expect(insert).toBeDefined()
  })

  it('stops after the committed batch when cancellation is signalled', async () => {
    const directory = await makeTemporaryDirectory()
    const inputFile = join(directory, 'orders.jsonl')
    await writeFile(
      inputFile,
      [
        JSON.stringify({ id: 1, name: 'Alice' }),
        JSON.stringify({ id: 2, name: 'Bob' })
      ].join('\n') + '\n',
      'utf8'
    )

    const inserts: Array<{ sql: string; values: unknown[] }> = []
    const fake = createFakeClient({
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes('FROM information_schema.COLUMNS')) {
          return [
            {
              column_name: 'id',
              data_type: 'bigint',
              is_nullable: 'NO',
              column_key: 'PRI',
              extra: ''
            },
            {
              column_name: 'name',
              data_type: 'varchar(255)',
              is_nullable: 'YES',
              column_key: '',
              extra: ''
            }
          ]
        }
        inserts.push({ sql, values: values ?? [] })
        return []
      }) as FakeClientOptions['query']
    })
    const service = new MySQLService(() => fake)

    await expect(
      service.importJsonl(
        connection,
        {
          connectionId: connection.id,
          table: { schema: 'app', name: 'orders' },
          inputFile,
          batchSize: 1,
          onConflict: 'error',
          database: 'app'
        },
        () => {
          throw new TaskCancelledError('task-1')
        }
      )
    ).rejects.toBeInstanceOf(TaskCancelledError)

    expect(inserts).toHaveLength(1)
    expect(inserts[0]?.values).toEqual([1, 'Alice'])
  })
})

interface FakeClientOptions {
  connect?: MySQLClientLike['connect']
  end?: MySQLClientLike['end']
  /** Loose mock signature: the service's generic `query<T>` is not mock-friendly. */
  query?: (sql: string, params?: unknown[]) => Promise<any[]>
  stream?: MySQLClientLike['stream']
}

function createFakeClient(options: FakeClientOptions = {}): MySQLClientLike {
  return {
    connect: options.connect ?? vi.fn(async () => undefined),
    end: options.end ?? vi.fn(async () => undefined),
    query:
      (options.query as unknown as MySQLClientLike['query']) ??
      (vi.fn(async () => [] as MySQLQueryResultRow[]) as unknown as MySQLClientLike['query']),
    stream: options.stream ?? (vi.fn(() => Readable.from([])) as unknown as MySQLClientLike['stream'])
  }
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'data-migrator-mysql-test-'))
  temporaryDirectories.push(directory)
  return directory
}

// Keep the MySQLRowStream import meaningful for type-checking the fake stream contract.
export type _MySQLRowStream = MySQLRowStream

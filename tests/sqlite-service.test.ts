import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { SQLiteService } from '../src/main/sqlite-service'
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

describe('SQLiteService', () => {
  it('lists tables, columns, and exact row counts', async () => {
    const { connection } = await createFixture()
    const service = new SQLiteService()

    const tables = await service.listTables(connection)

    expect(tables).toHaveLength(1)
    expect(tables[0]).toMatchObject({
      schema: 'main',
      name: 'users',
      estimatedRows: null
    })
    expect(tables[0]?.columns.map((column) => column.name)).toEqual(['id', 'name'])
    expect(tables[0]?.columns[0]?.isPrimaryKey).toBe(true)
    await expect(service.countRows(connection, {
      connectionId: connection.id,
      table: { schema: 'main', name: 'users' }
    })).resolves.toBe(3)
  })

  it('exports rows as shared batch JSONL', async () => {
    const { connection, directory } = await createFixture()
    const outputFile = join(directory, 'users.jsonl')
    const service = new SQLiteService()
    const progress: number[] = []

    const result = await service.exportTable(
      connection,
      {
        connectionId: connection.id,
        table: { schema: 'main', name: 'users' },
        outputFile,
        batchSize: 2
      },
      (rows) => progress.push(rows)
    )

    expect(result.rows).toBe(3)
    expect(progress).toEqual([2, 3])
    const lines = (await readFile(outputFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines).toEqual([
      {
        table: { schema: 'main', name: 'users' },
        columns: ['id', 'name'],
        rows: [[1, 'Alice'], [2, 'Bob']]
      },
      {
        table: { schema: 'main', name: 'users' },
        columns: ['id', 'name'],
        rows: [[3, 'Carol']]
      }
    ])
  })

  it('resumes from the written row count and appends to .part', async () => {
    const { connection, directory } = await createFixture()
    const outputFile = join(directory, 'users.jsonl')
    const temporaryPath = `${outputFile}.part`
    await writeFile(
      temporaryPath,
      `${JSON.stringify({
        table: { schema: 'main', name: 'users' },
        columns: ['id', 'name'],
        rows: [[1, 'Alice'], [2, 'Bob']]
      })}\n`,
      'utf8'
    )

    const service = new SQLiteService()
    const result = await service.exportTable(
      connection,
      {
        connectionId: connection.id,
        table: { schema: 'main', name: 'users' },
        outputFile,
        batchSize: 10
      },
      undefined,
      2
    )

    expect(result.rows).toBe(3)
    const lines = (await readFile(outputFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines).toHaveLength(2)
    expect(lines[1]?.rows).toEqual([[3, 'Carol']])
    await expect(stat(temporaryPath)).rejects.toThrow()
  })

  it('keeps the committed .part batch when cancellation is signalled', async () => {
    const { connection, directory } = await createFixture()
    const outputFile = join(directory, 'users.jsonl')
    const service = new SQLiteService()

    await expect(
      service.exportTable(
        connection,
        {
          connectionId: connection.id,
          table: { schema: 'main', name: 'users' },
          outputFile,
          batchSize: 2
        },
        () => {
          throw new TaskCancelledError('task-1')
        }
      )
    ).rejects.toBeInstanceOf(TaskCancelledError)

    const content = await readFile(`${outputFile}.part`, 'utf8')
    const line = JSON.parse(content.trim())
    expect(line.rows).toEqual([[1, 'Alice'], [2, 'Bob']])
  })
})

async function createFixture(): Promise<{
  connection: ConnectionConfig
  directory: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'data-migrator-sqlite-test-'))
  temporaryDirectories.push(directory)
  const filePath = join(directory, 'source.db')
  const database = new Database(filePath)
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  const insert = database.prepare('INSERT INTO users (id, name) VALUES (?, ?)')
  insert.run(1, 'Alice')
  insert.run(2, 'Bob')
  insert.run(3, 'Carol')
  database.close()

  return {
    directory,
    connection: {
      id: 'connection-sqlite',
      name: 'SQLite fixture',
      type: 'sqlite',
      host: filePath,
      port: 0,
      filePath,
      ssl: false,
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z'
    }
  }
}

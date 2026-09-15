/**
 * MySQL 真实数据库集成测试（默认跳过）。
 *
 * 启用方式（与既有 PG / ES 集成测试同一约定）：
 *   MYSQL_INTEGRATION_DSN='mysql://root:root@127.0.0.1:23306/app' npm test
 *
 * 覆盖验收标准：AC2（listDatabases / listTables / countRows 与 PG 对齐）、
 * AC3（流式 JSONL 信封）、AC4（`.part` 续传）、AC5（取消保留 .part 并立即停游标）、
 * AC6（errno 可读错误信息）。
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import mysql from 'mysql2/promise'
import { afterAll, describe, expect, it } from 'vitest'

import { MySQLService } from '../src/main/mysql-service'
import { TaskCancelledError } from '../src/main/task-errors'
import type { ConnectionConfig } from '../src/shared/types'

const dsn = process.env.MYSQL_INTEGRATION_DSN ?? ''
const enabled = dsn.trim().length > 0
const parsed = enabled ? new URL(dsn) : null
const database = parsed ? parsed.pathname.replace(/^\//, '') : ''
const directory = enabled ? await mkdtemp(join(tmpdir(), 'data-migrator-mysql-integration-')) : ''

const connection: ConnectionConfig = {
  id: 'integration-mysql',
  name: 'MySQL 集成测试库',
  type: 'mysql',
  host: parsed?.hostname ?? '127.0.0.1',
  port: Number(parsed?.port || 3306),
  username: parsed ? decodeURIComponent(parsed.username) : '',
  password: parsed ? decodeURIComponent(parsed.password) : '',
  database,
  ssl: false,
  createdAt: '2026-09-19T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z'
}

// 管理连接（无默认库）：负责建库 / 清库；数据连接：负责造数。
const admin = enabled && parsed ? await mysql.createConnection({ ...driverOptions() }) : null
if (admin && database) {
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database.replace(/`/g, '``')}\``)
}
const client = enabled && parsed ? await mysql.createConnection({ ...driverOptions(), database }) : null

afterAll(async () => {
  if (client) {
    await client.query('DROP TABLE IF EXISTS migration_source').catch(() => undefined)
    await client.end().catch(() => undefined)
  }
  if (admin) {
    await admin.end().catch(() => undefined)
  }
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe.skipIf(!enabled)('MySQL integration', () => {
  it('exports JSONL with cancel + resume through a real mysql2 connection', async () => {
    if (!client) {
      return
    }

    await client.query('DROP TABLE IF EXISTS migration_source')
    await client.query(`
      CREATE TABLE migration_source (
        id BIGINT PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        payload JSON,
        created_at DATETIME
      )
    `)
    const seedRows = Array.from({ length: 100 }, (_, index) => [
      index + 1,
      `user-${index + 1}`,
      JSON.stringify({ index: index + 1 }),
      '2026-01-01 00:00:00'
    ])
    await client.query(
      'INSERT INTO migration_source (id, name, payload, created_at) VALUES ?',
      [seedRows]
    )

    const service = new MySQLService()

    const test = await service.testConnection(connection)
    expect(test.ok).toBe(true)
    if (test.ok) {
      expect(test.serverVersion).not.toBe('')
    }

    expect(await service.listDatabases(connection)).toContain(database)

    const tables = await service.listTables(connection, database)
    const source = tables.find((table) => table.name === 'migration_source')
    expect(source).toBeDefined()
    expect(source?.schema).toBe(database)
    expect(source?.columns.map((column) => column.name)).toEqual([
      'id',
      'name',
      'payload',
      'created_at'
    ])
    expect(source?.columns.find((column) => column.name === 'id')?.isPrimaryKey).toBe(true)

    expect(
      await service.countRows(connection, {
        connectionId: connection.id,
        table: { schema: database, name: 'migration_source' },
        database
      })
    ).toBe(100)

    // AC5 + AC4：第二批复盘前取消 → 保留 .part，目标文件不产出。
    const outputFile = join(directory, 'migration_source.jsonl')
    let batches = 0
    await expect(
      service.exportTable(
        connection,
        {
          connectionId: connection.id,
          table: { schema: database, name: 'migration_source' },
          outputFile,
          batchSize: 40,
          database
        },
        () => {
          batches += 1
          if (batches >= 2) {
            throw new TaskCancelledError('integration-mysql')
          }
        }
      )
    ).rejects.toBeInstanceOf(TaskCancelledError)

    const partialLines = (await readFile(`${outputFile}.part`, 'utf8')).trim().split('\n')
    expect(partialLines).toHaveLength(2)
    await expect(stat(outputFile)).rejects.toThrow()

    // AC4：从已写行数续传（ORDER BY 主键 + LIMIT/OFFSET）。
    const resumed = await service.exportTable(
      connection,
      {
        connectionId: connection.id,
        table: { schema: database, name: 'migration_source' },
        outputFile,
        batchSize: 40,
        database
      },
      undefined,
      80
    )
    expect(resumed.rows).toBe(100)
    expect(resumed.bytes).toBeGreaterThan(0)

    // AC3：JSONL 信封与 PG/ES 严格同构。
    const lines = (await readFile(outputFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { table: unknown; columns: string[]; rows: unknown[][] })
    expect(lines).toHaveLength(3)
    expect(lines[0]?.table).toEqual({ schema: database, name: 'migration_source' })
    expect(lines[0]?.columns).toEqual(['id', 'name', 'payload', 'created_at'])
    expect(lines.map((line) => line.rows.length)).toEqual([40, 40, 20])
    // BIGINT 以字符串下发（supportBigNumbers + bigNumberStrings），与 pg 的 int8 行为一致。
    expect(lines.flatMap((line) => line.rows.map((row) => row[0]))).toEqual(
      Array.from({ length: 100 }, (_, index) => String(index + 1))
    )

    // 批量导出：每表一个 JSONL 文件，命名与 PG 一致（schema.table.jsonl）。
    const exportDirectory = join(directory, 'batch')
    const batchResult = await service.exportTables(connection, {
      connectionId: connection.id,
      tables: [{ schema: database, name: 'migration_source' }],
      outputDirectory: exportDirectory,
      batchSize: 50,
      database
    })
    expect(batchResult.rows).toBe(100)
    expect(batchResult.tables).toHaveLength(1)
    const batchFile = join(exportDirectory, `${database}.migration_source.jsonl`)
    expect((await readFile(batchFile, 'utf8')).trim().split('\n')).toHaveLength(2)
  })

  it('surfaces readable errno for bad credentials and unknown databases', async () => {
    const service = new MySQLService()

    const denied = await service.testConnection({ ...connection, password: 'definitely-wrong' })
    expect(denied.ok).toBe(false)
    if (!denied.ok) {
      expect(denied.message).toContain('ER_ACCESS_DENIED_ERROR')
      expect(denied.message).toContain('Access denied')
    }

    const missing = await service.testConnection(connection, 'no_such_database_for_dmt')
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.message).toContain('ER_BAD_DB_ERROR')
    }
  })
})

function driverOptions(): mysql.ConnectionOptions {
  return {
    host: connection.host,
    port: connection.port,
    user: connection.username,
    password: connection.password,
    multipleStatements: false
  }
}

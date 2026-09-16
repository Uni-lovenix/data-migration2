/**
 * Real roundtrip integration test for mysql-import.
 * Connects to the dm-mysql-import-test container at 127.0.0.1:23307.
 * No mocks; uses the real MySQLService + real mysql2 driver.
 *
 * Run with: MYSQL_INTEGRATION=1 npx vitest run tests/mysql-import.integration.test.ts --no-cache
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MySQLService } from '../src/main/mysql-service'

const HOST = process.env.MYSQL_INTEGRATION_HOST || '127.0.0.1'
const PORT = Number(process.env.MYSQL_INTEGRATION_PORT || 23307)
const USER = 'root'
const PASSWORD = 'rootpass'
const DATABASE = 'dm_test'
const TABLE = 'import_target'
const JSONL_PATH = '/tmp/mysql-import-seed.jsonl'

const integrationEnabled = process.env.MYSQL_INTEGRATION === '1'

const describeIf = integrationEnabled ? describe : describe.skip

describeIf('MySQLService.importJsonl (real Docker integration)', () => {
  const service = new MySQLService()
  const connection = {
    id: 'integration',
    name: 'mysql-import-integration',
    type: 'mysql' as const,
    host: HOST,
    port: PORT,
    username: USER,
    password: PASSWORD,
    database: DATABASE
  }

  beforeAll(async () => {
    const mysql = await import('mysql2/promise')
    const conn = await mysql.createConnection({
      host: HOST, port: PORT, user: USER, password: PASSWORD, database: DATABASE
    })
    await conn.query(`DROP TABLE IF EXISTS ${TABLE}`)
    await conn.query(`
      CREATE TABLE ${TABLE} (
        id INT PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        active TINYINT(1) NOT NULL,
        score DECIMAL(10,2),
        payload JSON,
        created_at DATETIME
      )
    `)
    await conn.query(
      `INSERT INTO ${TABLE} (id, name, active, score, payload, created_at) VALUES ` +
        "(1, 'existing-a', 1, 10.00, JSON_OBJECT('k','old1'), '2024-01-01 00:00:00')," +
        "(2, 'existing-b', 1, 20.00, JSON_OBJECT('k','old2'), '2024-01-01 00:00:00')," +
        "(3, 'existing-c', 0, 30.00, JSON_OBJECT('k','old3'), '2024-01-01 00:00:00')"
    )
    await conn.end()

    // Write JSONL envelope: 5 rows (3 conflict + 2 fresh)
    // JSONL envelope rows are positional arrays (column-array shape), not objects.
    const rows = [
      [1, 'updated-a', 1, 11.11, JSON.stringify({ k: 'new1' }), '2024-12-31 23:59:59'],
      [2, 'updated-b', 0, 22.22, JSON.stringify({ k: 'new2' }), '2024-12-31 23:59:59'],
      [3, 'updated-c', 1, 33.33, JSON.stringify({ k: 'new3' }), '2024-12-31 23:59:59'],
      [4, 'fresh-d', 1, 44.44, JSON.stringify({ k: 'new4' }), '2024-12-31 23:59:59'],
      [5, 'fresh-e', 0, 55.55, JSON.stringify({ k: 'new5' }), '2024-12-31 23:59:59']
    ]
    const envelope = {
      table: { schema: DATABASE, name: TABLE },
      columns: ['id', 'name', 'active', 'score', 'payload', 'created_at'],
      rows
    }
    writeFileSync(JSONL_PATH, JSON.stringify(envelope) + '\n')
  })

  afterAll(async () => {
    if (existsSync(JSONL_PATH)) rmSync(JSONL_PATH)
  })

  async function readRows() {
    const mysql = await import('mysql2/promise')
    const conn = await mysql.createConnection({
      host: HOST, port: PORT, user: USER, password: PASSWORD, database: DATABASE
    })
    const [rows] = await conn.query(
      `SELECT id, name FROM ${TABLE} ORDER BY id`
    )
    await conn.end()
    return rows as Array<{ id: number; name: string }>
  }

  it('skip on conflict: preserves existing rows and inserts new ones', async () => {
    const result = await service.importJsonl(connection, {
      connectionId: 'integration',
      table: { schema: DATABASE, name: TABLE },
      inputFile: JSONL_PATH,
      batchSize: 100,
      onConflict: 'skip'
    })
    expect(result.rows).toBe(5)

    const rows = await readRows()
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5])
    // Existing names preserved
    expect(rows[0].name).toBe('existing-a')
    expect(rows[1].name).toBe('existing-b')
    expect(rows[2].name).toBe('existing-c')
    expect(rows[3].name).toBe('fresh-d')
    expect(rows[4].name).toBe('fresh-e')
  })

  it('error on conflict: throws when row conflicts with existing PK', async () => {
    await expect(
      service.importJsonl(connection, {
        connectionId: 'integration',
        table: { schema: DATABASE, name: TABLE },
        inputFile: JSONL_PATH,
        batchSize: 100,
        onConflict: 'error'
      })
    ).rejects.toThrow()
  })

  it('missing column: produces actionable message naming the bad column', async () => {
    const badPath = '/tmp/mysql-import-bad.jsonl'
    writeFileSync(
      badPath,
      JSON.stringify({
        table: { schema: DATABASE, name: TABLE },
        columns: ['id', 'name', 'active', 'does_not_exist'],
        rows: [[99, 'bogus', 1, 'x']]
      }) + '\n'
    )
    try {
      await expect(
        service.importJsonl(connection, {
          connectionId: 'integration',
          table: { schema: DATABASE, name: TABLE },
          inputFile: badPath,
          batchSize: 100,
          onConflict: 'skip'
        })
      ).rejects.toThrow(/does_not_exist/)
    } finally {
      rmSync(badPath, { force: true })
    }
  })
})

// Always-on unit test for toMysqlValue cast (no DB needed)
describe('toMysqlValue cast rules', () => {
  it('casts null/undefined/boolean/Date/Buffer/object/array correctly', async () => {
    const { toMysqlValue } = await import('../src/main/mysql-service')
    expect(toMysqlValue(null)).toBe(null)
    expect(toMysqlValue(undefined)).toBe(null)
    expect(toMysqlValue(true)).toBe(1)
    expect(toMysqlValue(false)).toBe(0)
    const d = new Date('2024-05-01T10:20:30.456Z')
    const out = toMysqlValue(d) as string
    // Local-time formatted; we just check it's a non-empty string with the right shape.
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/)
    expect(toMysqlValue(Buffer.from('hello'))).toBe('68656c6c6f')
    expect(toMysqlValue({ k: 'v' })).toBe('{"k":"v"}')
    expect(toMysqlValue([1, 2, 3])).toBe('[1,2,3]')
    expect(toMysqlValue({ type: 'Buffer', data: [1, 2] })).toBe('0102')
    expect(toMysqlValue(42)).toBe(42)
    expect(toMysqlValue('plain')).toBe('plain')
  })
})
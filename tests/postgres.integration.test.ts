import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'

import { PostgresService } from '../src/main/postgres-service'
import type { ConnectionConfig } from '../src/shared/types'

const enabled = process.env.POSTGRES_INTEGRATION === '1'
const port = Number(process.env.POSTGRES_INTEGRATION_PORT ?? 55432)
const directory = enabled ? await mkdtemp(join(tmpdir(), 'data-migrator-pg-integration-')) : ''
const admin = enabled ? new Client({ host: '127.0.0.1', port, user: 'postgres', password: 'secret', database: 'app' }) : null

const connection: ConnectionConfig = {
  id: 'integration',
  name: '集成测试库',
  type: 'postgresql',
  host: '127.0.0.1',
  port,
  username: 'postgres',
  password: 'secret',
  database: 'app',
  ssl: false,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z'
}

afterAll(async () => {
  if (admin) {
    await admin
      .query('DROP TABLE IF EXISTS public.migration_source, public.migration_target')
      .catch(() => undefined)
    await admin.end()
  }
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe.skipIf(!enabled)('PostgreSQL integration', () => {
  it('exports and imports table data through JSONL', async () => {
    if (!admin) {
      return
    }
    await admin.connect()
    await admin.query(`
      DROP TABLE IF EXISTS public.migration_source, public.migration_target;
      CREATE TABLE public.migration_source (
        id bigint PRIMARY KEY,
        name text NOT NULL,
        profile jsonb,
        created_at timestamptz
      );
      CREATE TABLE public.migration_target (LIKE public.migration_source INCLUDING ALL);
      INSERT INTO public.migration_source
      SELECT
        i,
        'user-' || i,
        jsonb_build_object('index', i),
        now()
      FROM generate_series(1, 100) AS i;
    `)

    const service = new PostgresService()
    const databases = await service.listDatabases(connection)
    expect(databases).toContain('app')
    expect(databases).toContain('template0')
    const tables = await service.listTables(connection)
    const source = tables.find(
      (table) => table.schema === 'public' && table.name === 'migration_source'
    )
    expect(source).toBeDefined()

    const outputFile = join(directory, 'migration_source.jsonl')
    const exportResult = await service.exportTable(connection, {
      connectionId: connection.id,
      table: { schema: 'public', name: 'migration_source' },
      outputFile,
      batchSize: 50
    })
    expect(exportResult.rows).toBe(100)
    expect(exportResult.bytes).toBeGreaterThan(0)

    const lines = (await readFile(outputFile, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(100)

    const exportDirectory = join(directory, 'batch')
    const batchResult = await service.exportTables(connection, {
      connectionId: connection.id,
      tables: [
        { schema: 'public', name: 'migration_source' },
        { schema: 'public', name: 'migration_target' }
      ],
      outputDirectory: exportDirectory,
      batchSize: 50
    })
    expect(batchResult.rows).toBe(100)
    expect(batchResult.tables).toHaveLength(2)
    expect(
      (await readFile(join(exportDirectory, 'public.migration_source.jsonl'), 'utf8'))
        .trim()
        .split('\n')
    ).toHaveLength(100)

    const sourceCount = await service.countRows(connection, {
      connectionId: connection.id,
      table: { schema: 'public', name: 'migration_source' },
      database: 'app'
    })
    const targetCount = await service.countRows(connection, {
      connectionId: connection.id,
      table: { schema: 'public', name: 'migration_target' },
      database: 'app'
    })
    expect(sourceCount).toBe(100)
    expect(targetCount).toBe(0)

    const importResult = await service.importJsonl(connection, {
      connectionId: connection.id,
      table: { schema: 'public', name: 'migration_target' },
      inputFile: outputFile,
      batchSize: 40,
      onConflict: 'skip'
    })
    expect(importResult.rows).toBe(100)

    const count = await admin.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM public.migration_target'
    )
    expect(count.rows[0]?.count).toBe('100')
  })
})

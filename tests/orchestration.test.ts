import { describe, expect, it } from 'vitest'

import { OrchestrationService } from '../src/main/orchestration-service'

const connection = {
  id: 'connection-1',
  name: 'test',
  type: 'postgresql' as const,
  host: 'localhost',
  port: 5432,
  ssl: false,
  createdAt: '2026-09-17T00:00:00Z',
  updatedAt: '2026-09-17T00:00:00Z'
}

function createService(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  const service = new OrchestrationService({
    connections: {
      get: async () => connection
    },
    postgres: {
      previewTable: async () => [{ id: 1, name: 'Alice' }],
      listTables: async () => [
        {
          schema: 'public',
          name: 'users',
          estimatedRows: null,
          columns: [
            {
              name: 'id',
              dataType: 'integer',
              isNullable: false,
              isPrimaryKey: true,
              isGenerated: false
            },
            {
              name: 'name',
              dataType: 'text',
              isNullable: true,
              isPrimaryKey: false,
              isGenerated: false
            }
          ]
        }
      ]
    },
    mysql: {
      previewTable: async () => [],
      listTables: async () => []
    },
    sqlite: { previewTable: async () => [] },
    hive: {
      previewTable: async () => [],
      listColumns: async () => []
    },
    elasticsearch: {
      previewIndex: async () => [],
      listIndices: async () => [
        {
          name: 'logs',
          health: 'green',
          status: 'open',
          docsCount: 1,
          storeSize: '1kb',
          aliases: [],
          fields: [
            { name: 'message', type: 'keyword' },
            { name: 'level', type: 'keyword' }
          ]
        }
      ]
    },
    taskManager: {
      create: (input: unknown) => {
        calls.push('task')
        return { id: 'task-1', status: 'queued', ...(input as object) }
      },
      cancel: () => ({ id: 'task-1', status: 'canceled' })
    },
    ...overrides
  } as unknown as ConstructorParameters<typeof OrchestrationService>[0])
  return { service, calls }
}

describe('OrchestrationService', () => {
  it('executes linear steps in order', async () => {
    const { service, calls } = createService()
    const result = await service.orchestrate([
      { atom: 'export_preview', source: 'postgresql', connectionId: connection.id, limit: 10, table: { schema: 'public', name: 'users' } },
      { atom: 'cast_dry_run', row: { id: 1 }, transforms: [] }
    ])
    expect(result.summary).toMatchObject({ completed: 2, failed: 0, skipped: 0 })
    expect(calls).toEqual([])
  })

  it('skips subsequent steps after a failure', async () => {
    const { service } = createService()
    const result = await service.orchestrate([
      { atom: 'unknown_atom' },
      { atom: 'cast_dry_run', row: { id: 1 }, transforms: [] }
    ])
    expect(result.steps.map((step) => step.status)).toEqual(['failed', 'skipped'])
  })

  it('returns export preview columns and rows', async () => {
    const { service } = createService()
    const result = await service.exportPreview({
      source: 'postgresql',
      connectionId: connection.id,
      limit: 10,
      table: { schema: 'public', name: 'users' }
    })
    expect(result).toEqual({
      source: 'postgresql',
      columns: ['id', 'name'],
      rows: [{ id: 1, name: 'Alice' }]
    })
  })

  it('rejects import validation when target columns are missing', async () => {
    const { service } = createService()
    await expect(
      service.importValidate({
        target: 'postgresql',
        connectionId: connection.id,
        table: { schema: 'public', name: 'users' },
        columns: ['id', 'missing']
      })
    ).rejects.toThrow(/missing/)
  })

  it('validates Elasticsearch target fields from index mapping', async () => {
    const { service } = createService()
    await expect(
      service.importValidate({
        target: 'elasticsearch',
        connectionId: connection.id,
        index: 'logs',
        columns: ['message', 'missing']
      })
    ).rejects.toThrow(/missing/)

    await expect(
      service.importValidate({
        target: 'elasticsearch',
        connectionId: connection.id,
        index: 'logs',
        columns: ['message', 'level']
      })
    ).resolves.toMatchObject({
      target: 'elasticsearch',
      ok: true,
      existingColumns: ['message', 'level']
    })
  })

  it('returns cast dry-run conversion results', () => {
    const { service } = createService()
    expect(
      service.castDryRun({
        row: { active: 2 },
        transforms: [
          {
            sourceColumn: 'active',
            sourceType: 'int',
            targetType: 'boolean',
            strategy: 'cast'
          }
        ]
      })
    ).toEqual({ row: { active: true } })
  })
})

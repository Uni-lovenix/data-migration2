import { describe, expect, it } from 'vitest'

import {
  DATA_DIR_VARIABLE,
  TasksToTemplateDraftError,
  tasksToTemplateDraft
} from '../src/shared/template-from-tasks'
import type {
  MigrationTask,
  PostgresBatchExportRequest,
  PostgresExportRequest,
  PostgresImportRequest
} from '../src/shared/types'

function makeTask(overrides: Partial<MigrationTask> = {}): MigrationTask {
  const base: MigrationTask = {
    id: '11111111-1111-1111-1111-111111111111',
    type: 'postgres-export',
    status: 'completed',
    connectionId: 'conn-pg',
    payload: {
      connectionId: 'conn-pg',
      table: { schema: 'public', name: 'users' },
      outputFile: '/data/exports/users.jsonl',
      batchSize: 5000
    },
    progress: 100,
    createdAt: '2026-09-10T00:00:00.000Z'
  }
  const merged: MigrationTask = { ...base, ...overrides }
  if (overrides.payload !== undefined) {
    merged.payload = overrides.payload
  }
  return merged
}

const resolveByName: (id: string) => string | undefined = (id) => {
  const map: Record<string, string> = {
    'conn-pg': 'pg-prod',
    'conn-es': 'es-prod',
    'conn-pg-2': 'pg-staging'
  }
  return map[id]
}

function callDraft(tasks: MigrationTask[], overrides: Record<string, unknown> = {}) {
  return tasksToTemplateDraft({
    tasks,
    connectionResolver: resolveByName,
    name: 'combo',
    ...overrides
  })
}

describe('tasksToTemplateDraft', () => {
  it('throws on empty task list', () => {
    expect(() => callDraft([])).toThrow(TasksToTemplateDraftError)
    expect(() => callDraft([])).toThrow('至少选择一个任务')
  })

  it('throws on blank template name', () => {
    expect(() => callDraft([makeTask()], { name: '   ' })).toThrow('模板名称不能为空')
  })

  it('throws when a connection id cannot be resolved', () => {
    const task = makeTask({ connectionId: 'gone' })
    try {
      callDraft([task])
      expect.fail('should have thrown')
    } catch (cause) {
      expect(cause).toBeInstanceOf(TasksToTemplateDraftError)
      expect((cause as Error).message).toContain('已不存在')
      expect((cause as Error).message).toContain('gone')
    }
  })

  it('maps postgres-export to pgmigrator + export', () => {
    const { input } = callDraft([makeTask()])
    expect(input.engine).toBe('pgmigrator')
    expect(input.action).toBe('export')
    expect(input.connectionName).toBe('pg-prod')
    expect(input.steps).toHaveLength(1)
  })

  it('maps postgres-export-batch to a single pgmigrator + export step (no splitting)', () => {
    const payload: PostgresBatchExportRequest = {
      connectionId: 'conn-pg',
      tables: [
        { schema: 'public', name: 'users' },
        { schema: 'public', name: 'orders' }
      ],
      outputDirectory: '/data/exports/pg-prod',
      batchSize: 5000
    }
    const { input } = callDraft([makeTask({ type: 'postgres-export-batch', payload })])
    expect(input.steps).toHaveLength(1)
    expect(input.engine).toBe('pgmigrator')
    expect(input.action).toBe('export')
    const config = JSON.parse(input.steps[0]!.configJson) as Record<string, unknown>
    expect(config.tables).toEqual([
      { schema: 'public', name: 'users' },
      { schema: 'public', name: 'orders' }
    ])
    expect(config.outputDirectory).toBe('{{DATA_DIR}}')
  })

  it('maps postgres-import to pgmigrator + import', () => {
    const payload: PostgresImportRequest = {
      connectionId: 'conn-pg',
      table: { schema: 'public', name: 'users' },
      inputFile: '/data/import/users.jsonl',
      batchSize: 5000,
      onConflict: 'skip'
    }
    const { input } = callDraft([makeTask({ type: 'postgres-import', payload })])
    expect(input.engine).toBe('pgmigrator')
    expect(input.action).toBe('import')
    const config = JSON.parse(input.steps[0]!.configJson) as Record<string, unknown>
    expect(config.inputFile).toBe('{{DATA_DIR}}/users.jsonl')
    expect(config.table).toEqual({ schema: 'public', name: 'users' })
  })

  it('maps elasticsearch-export to esmigrator + export', () => {
    const payload = {
      connectionId: 'conn-es',
      index: 'logs-2026',
      outputFile: '/data/exports/logs.jsonl',
      batchSize: 5000,
      strategy: 'search_after' as const
    }
    const { input } = callDraft([
      makeTask({ type: 'elasticsearch-export', connectionId: 'conn-es', payload })
    ])
    expect(input.engine).toBe('esmigrator')
    expect(input.action).toBe('export')
    expect(input.connectionName).toBe('es-prod')
    const config = JSON.parse(input.steps[0]!.configJson) as Record<string, unknown>
    expect(config.outputFile).toBe('{{DATA_DIR}}/logs.jsonl')
    expect(config.strategy).toBe('search_after')
  })

  it('maps elasticsearch-import to esmigrator + import', () => {
    const payload = {
      connectionId: 'conn-es',
      index: 'logs',
      inputFile: '/data/import/logs.jsonl',
      batchSize: 5000,
      onConflict: 'overwrite' as const
    }
    const { input } = callDraft([
      makeTask({ type: 'elasticsearch-import', connectionId: 'conn-es', payload })
    ])
    expect(input.engine).toBe('esmigrator')
    expect(input.action).toBe('import')
    const config = JSON.parse(input.steps[0]!.configJson) as Record<string, unknown>
    expect(config.inputFile).toBe('{{DATA_DIR}}/logs.jsonl')
  })

  it('rewrites outputFile to {{DATA_DIR}}/<basename>', () => {
    const payload: PostgresExportRequest = {
      connectionId: 'conn-pg',
      table: { schema: 'public', name: 'users' },
      outputFile: '/var/lib/data/pg/exports/users-{{TODAY}}.jsonl',
      batchSize: 5000
    }
    const { input } = callDraft([makeTask({ payload })])
    const config = JSON.parse(input.steps[0]!.configJson) as Record<string, unknown>
    expect(config.outputFile).toBe(`{{${DATA_DIR_VARIABLE}}}/users-{{TODAY}}.jsonl`)
  })

  it('strips Windows-style backslash paths down to the basename too', () => {
    const payload: PostgresExportRequest = {
      connectionId: 'conn-pg',
      table: { schema: 'public', name: 'users' },
      outputFile: 'C:\\data\\exports\\users.jsonl',
      batchSize: 5000
    }
    const { input } = callDraft([makeTask({ payload })])
    const config = JSON.parse(input.steps[0]!.configJson) as Record<string, unknown>
    expect(config.outputFile).toBe('{{DATA_DIR}}/users.jsonl')
  })

  it('rewrites a bare filename to {{DATA_DIR}}/', () => {
    const payload: PostgresExportRequest = {
      connectionId: 'conn-pg',
      table: { schema: 'public', name: 'users' },
      outputFile: 'users.jsonl',
      batchSize: 5000
    }
    const { input } = callDraft([makeTask({ payload })])
    const config = JSON.parse(input.steps[0]!.configJson) as Record<string, unknown>
    expect(config.outputFile).toBe(`{{${DATA_DIR_VARIABLE}}}/users.jsonl`)
  })

  it('rewrites outputDirectory to {{DATA_DIR}} (preserving trailing slash)', () => {
    const payload: PostgresBatchExportRequest = {
      connectionId: 'conn-pg',
      tables: [{ schema: 'public', name: 'users' }],
      outputDirectory: '/data/exports/',
      batchSize: 5000
    }
    const { input } = callDraft([makeTask({ type: 'postgres-export-batch', payload })])
    const config = JSON.parse(input.steps[0]!.configJson) as Record<string, unknown>
    expect(config.outputDirectory).toBe('{{DATA_DIR}}/')

    const noSlash: PostgresBatchExportRequest = { ...payload, outputDirectory: '/data/exports' }
    const { input: input2 } = callDraft([
      makeTask({ type: 'postgres-export-batch', payload: noSlash })
    ])
    const config2 = JSON.parse(input2.steps[0]!.configJson) as Record<string, unknown>
    expect(config2.outputDirectory).toBe('{{DATA_DIR}}')
  })

  it('leaves an empty path untouched so the user can fix it by hand', () => {
    const payload: PostgresExportRequest = {
      connectionId: 'conn-pg',
      table: { schema: 'public', name: 'users' },
      outputFile: '',
      batchSize: 5000
    }
    const { input } = callDraft([makeTask({ payload })])
    const config = JSON.parse(input.steps[0]!.configJson) as Record<string, unknown>
    expect(config.outputFile).toBe('')
  })

  it('strips connectionId, dstConnectionId and embedded type from each step config', () => {
    const payload = {
      connectionId: 'conn-pg',
      type: 'postgres-export',
      dstConnectionId: 'conn-other',
      table: { schema: 'public', name: 'users' },
      outputFile: '/data/users.jsonl',
      batchSize: 5000
    } as unknown as PostgresExportRequest
    const { input } = callDraft([makeTask({ payload })])
    const config = JSON.parse(input.steps[0]!.configJson) as Record<string, unknown>
    expect('connectionId' in config).toBe(false)
    expect('dstConnectionId' in config).toBe(false)
    expect('type' in config).toBe(false)
  })

  it('preserves step order from the caller (click order)', () => {
    const a = makeTask({
      id: 'aaaa',
      type: 'postgres-export',
      payload: {
        connectionId: 'conn-pg',
        table: { schema: 'public', name: 'a' },
        outputFile: '/x/a.jsonl',
        batchSize: 5000
      }
    })
    const b = makeTask({
      id: 'bbbb',
      type: 'elasticsearch-import',
      connectionId: 'conn-es',
      payload: {
        connectionId: 'conn-es',
        index: 'b',
        inputFile: '/x/b.jsonl',
        batchSize: 5000,
        onConflict: 'overwrite'
      }
    })
    const c = makeTask({
      id: 'cccc',
      type: 'postgres-import',
      payload: {
        connectionId: 'conn-pg',
        table: { schema: 'public', name: 'c' },
        inputFile: '/x/c.jsonl',
        batchSize: 5000,
        onConflict: 'skip'
      }
    })
    const { input } = callDraft([b, c, a])
    expect(input.steps.map((s) => s.connectionName)).toEqual(['es-prod', 'pg-prod', 'pg-prod'])
    expect(input.steps.map((s) => s.action)).toEqual(['import', 'import', 'export'])
    // First step's legacy fields mirror its own (engine/action/connectionName).
    expect(input.engine).toBe('esmigrator')
    expect(input.action).toBe('import')
    expect(input.connectionName).toBe('es-prod')
  })

  it('adds {{DATA_DIR}} as a template-level variable with description', () => {
    const { input } = callDraft([makeTask()], { dataDirDefault: '/var/data' })
    expect(input.variables).toHaveLength(1)
    expect(input.variables[0]!.name).toBe('DATA_DIR')
    expect(input.variables[0]!.defaultValue).toBe('/var/data')
    expect(input.variables[0]!.description).toContain('{{DATA_DIR}}')
  })

  it('defaults {{DATA_DIR}} to empty string when not provided', () => {
    const { input } = callDraft([makeTask()])
    expect(input.variables[0]!.defaultValue).toBe('')
  })

  it('trims the description but keeps it empty as undefined', () => {
    const { input } = callDraft([makeTask()], { description: '   ' })
    expect(input.description).toBeUndefined()

    const { input: input2 } = callDraft([makeTask()], { description: ' PG→ES daily ' })
    expect(input2.description).toBe('PG→ES daily')
  })

  it('throws on malformed payload (non-object)', () => {
    const task = makeTask({ payload: null as unknown as PostgresExportRequest })
    expect(() => callDraft([task])).toThrow(/payload 格式无效/)
  })
})

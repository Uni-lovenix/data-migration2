import { describe, expect, it } from 'vitest'

import {
  buildStepDescriptors,
  builtInVars,
  collectTemplateVariables,
  engineActionToTaskType,
  exampleConfigJson,
  replaceVariables,
  resolveTaskInput
} from '../src/main/template-utils'
import { exampleConfigJson as sharedExample } from '../src/shared/template-examples'
import type { MigrationTemplate } from '../src/shared/types'

describe('replaceVariables', () => {
  it('substitutes a single placeholder', () => {
    expect(replaceVariables('Hello {{NAME}}', { NAME: 'World' })).toBe('Hello World')
  })

  it('substitutes multiple placeholders in one string', () => {
    expect(
      replaceVariables('{{A}} + {{B}} = {{A}}', { A: '1', B: '2' })
    ).toBe('1 + 2 = 1')
  })

  it('leaves unknown placeholders untouched', () => {
    expect(replaceVariables('Hello {{NAME}}', {})).toBe('Hello {{NAME}}')
  })

  it('handles keys with underscores and digits', () => {
    expect(replaceVariables('{{USER_ID_2}}', { USER_ID_2: 'abc' })).toBe('abc')
  })

  it('does not re-scan replaced values', () => {
    expect(replaceVariables('{{A}}', { A: '{{B}}', B: 'C' })).toBe('{{B}}')
  })

  it('returns the original token when the value is null/undefined', () => {
    const vars: Record<string, string> = {}
    vars['KEY'] = undefined as unknown as string
    expect(replaceVariables('{{KEY}}', vars)).toBe('{{KEY}}')
  })

  it('returns input unchanged when no placeholders exist', () => {
    expect(replaceVariables('plain text', { ANY: 'thing' })).toBe('plain text')
  })
})

describe('builtInVars', () => {
  it('contains TODAY / NOW / TIMESTAMP entries', () => {
    const fixed = new Date('2026-09-10T12:34:56.000Z')
    const vars = builtInVars(fixed)
    expect(vars).toHaveProperty('TODAY')
    expect(vars).toHaveProperty('NOW')
    expect(vars).toHaveProperty('TIMESTAMP')
    expect(typeof vars.TIMESTAMP).toBe('string')
    expect(Number(vars.TIMESTAMP)).toBe(Math.floor(fixed.getTime() / 1000))
  })
})

describe('engineActionToTaskType', () => {
  it('maps every (engine, action) pair to a canonical runtime type', () => {
    expect(engineActionToTaskType('pgmigrator', 'export')).toBe('postgres-export')
    expect(engineActionToTaskType('pgmigrator', 'import')).toBe('postgres-import')
    expect(engineActionToTaskType('esmigrator', 'export')).toBe('elasticsearch-export')
    expect(engineActionToTaskType('esmigrator', 'import')).toBe('elasticsearch-import')
  })
})

describe('exampleConfigJson', () => {
  it('returns a parseable JSON for every (engine, action) combination', () => {
    const cases: Array<['pgmigrator' | 'esmigrator', 'export' | 'import']> = [
      ['pgmigrator', 'export'],
      ['pgmigrator', 'import'],
      ['esmigrator', 'export'],
      ['esmigrator', 'import']
    ]
    for (const [engine, action] of cases) {
      const json = exampleConfigJson(engine, action)
      expect(() => JSON.parse(json), `must be parseable: ${engine}/${action}`).not.toThrow()
      const parsed = JSON.parse(json) as { type: string }
      expect(parsed.type).toBe(engineActionToTaskType(engine, action))
    }
  })

  it('keeps the main-process and shared implementations in sync', () => {
    for (const engine of ['pgmigrator', 'esmigrator'] as const) {
      for (const action of ['export', 'import'] as const) {
        expect(exampleConfigJson(engine, action)).toBe(sharedExample(engine, action))
      }
    }
  })

  it('includes a {{TODAY}} placeholder so date-based paths work out of the box', () => {
    expect(exampleConfigJson('pgmigrator', 'export')).toContain('{{TODAY}}')
    expect(exampleConfigJson('esmigrator', 'export')).toContain('{{TODAY}}')
  })

  it('round-trips selectedColumns through import examples', () => {
    const pg = resolveTaskInput({
      engine: 'pgmigrator',
      action: 'import',
      connectionId: 'connection-pg',
      configJson: exampleConfigJson('pgmigrator', 'import'),
      vars: {}
    })
    expect(pg.payload).toMatchObject({
      selectedColumns: ['id', 'name', 'email', 'tags', 'created_at']
    })
    expect((pg.payload as { fieldTransforms?: unknown[] }).fieldTransforms).toHaveLength(3)

    const es = resolveTaskInput({
      engine: 'esmigrator',
      action: 'import',
      connectionId: 'connection-es',
      configJson: exampleConfigJson('esmigrator', 'import'),
      vars: {}
    })
    expect(es.payload).toMatchObject({
      selectedColumns: ['@timestamp', 'message', 'level', 'payload']
    })
    expect((es.payload as { fieldTransforms?: unknown[] }).fieldTransforms).toHaveLength(1)
  })
})

describe('resolveTaskInput', () => {
  const baseConfig = JSON.stringify({
    type: 'postgres-export',
    table: { schema: 'public', name: 'users' },
    outputFile: '/tmp/{{DATE}}-users.jsonl',
    batchSize: 500
  })

  it('substitutes variables and returns the expected task input', () => {
    const result = resolveTaskInput({
      engine: 'pgmigrator',
      action: 'export',
      connectionId: 'conn-1',
      configJson: baseConfig,
      vars: { DATE: '2026-09-10' }
    })
    expect(result.type).toBe('postgres-export')
    expect((result.payload as { outputFile: string }).outputFile).toBe(
      '/tmp/2026-09-10-users.jsonl'
    )
    expect((result.payload as { connectionId: string }).connectionId).toBe('conn-1')
  })

  it('falls back to engineActionToTaskType when payload.type is missing', () => {
    const config = JSON.stringify({
      table: { schema: 'public', name: 'users' },
      outputFile: '/tmp/u.jsonl',
      batchSize: 500
    })
    const result = resolveTaskInput({
      engine: 'esmigrator',
      action: 'import',
      connectionId: 'c',
      configJson: config,
      vars: {}
    })
    expect(result.type).toBe('elasticsearch-import')
  })

  it('honors an explicit type from the JSON when present', () => {
    const result = resolveTaskInput({
      engine: 'pgmigrator',
      action: 'export',
      connectionId: 'c',
      configJson: baseConfig,
      vars: {}
    })
    // The explicit `type` from the JSON is used, not the engine/action fallback.
    expect(result.type).toBe('postgres-export')
  })

  it('preserves ES query, exportMapping, createIndex and mapping fields through the template pipeline', () => {
    const exportConfig = JSON.stringify({
      type: 'elasticsearch-export',
      index: 'logs-{{DATE}}',
      outputFile: '/data/logs.jsonl',
      batchSize: 500,
      strategy: 'search_after',
      query: { range: { '@timestamp': { gte: 'now-7d' } } },
      exportMapping: true
    })
    const exportResult = resolveTaskInput({
      engine: 'esmigrator',
      action: 'export',
      connectionId: 'c',
      configJson: exportConfig,
      vars: { DATE: '2026-09-10' }
    })
    expect(exportResult.type).toBe('elasticsearch-export')
    expect(exportResult.payload).toMatchObject({
      index: 'logs-2026-09-10',
      query: { range: { '@timestamp': { gte: 'now-7d' } } },
      exportMapping: true
    })

    const importConfig = JSON.stringify({
      type: 'elasticsearch-import',
      index: 'logs',
      inputFile: '/data/logs.jsonl',
      batchSize: 500,
      onConflict: 'skip',
      createIndex: true,
      mapping: { source: 'sidecar' }
    })
    const importResult = resolveTaskInput({
      engine: 'esmigrator',
      action: 'import',
      connectionId: 'c',
      configJson: importConfig,
      vars: {}
    })
    expect(importResult.type).toBe('elasticsearch-import')
    expect(importResult.payload).toMatchObject({
      createIndex: true,
      mapping: { source: 'sidecar' }
    })
  })

  it('preserves the PG where field through the export template pipeline', () => {
    const config = JSON.stringify({
      type: 'postgres-export',
      table: { schema: 'public', name: 'orders' },
      outputFile: '/data/exports/orders-{{TODAY}}.jsonl',
      batchSize: 5000,
      database: 'postgres',
      where: "created_at >= NOW() - INTERVAL '7 days'"
    })
    const result = resolveTaskInput({
      engine: 'pgmigrator',
      action: 'export',
      connectionId: 'c',
      configJson: config,
      vars: {}
    })
    expect(result.type).toBe('postgres-export')
    expect(result.payload).toMatchObject({
      where: "created_at >= NOW() - INTERVAL '7 days'"
    })
  })

  it('always injects connectionId even if the user JSON provides a wrong one', () => {
    const config = JSON.stringify({
      type: 'postgres-export',
      table: { schema: 'public', name: 'users' },
      outputFile: '/tmp/u.jsonl',
      batchSize: 500,
      connectionId: 'WRONG'
    })
    const result = resolveTaskInput({
      engine: 'pgmigrator',
      action: 'export',
      connectionId: 'RIGHT',
      configJson: config,
      vars: {}
    })
    expect((result.payload as { connectionId: string }).connectionId).toBe('RIGHT')
  })

  it('adds dstConnectionId when provided', () => {
    const config = JSON.stringify({
      type: 'postgres-import',
      table: { schema: 'public', name: 'users' },
      inputFile: '/tmp/u.jsonl',
      batchSize: 500,
      onConflict: 'skip'
    })
    const result = resolveTaskInput({
      engine: 'pgmigrator',
      action: 'import',
      connectionId: 'src',
      dstConnectionId: 'dst',
      configJson: config,
      vars: {}
    })
    expect((result.payload as unknown as Record<string, unknown>).dstConnectionId).toBe('dst')
  })

  it('omits dstConnectionId when not provided', () => {
    const config = JSON.stringify({
      type: 'postgres-export',
      table: { schema: 'public', name: 'users' },
      outputFile: '/tmp/u.jsonl',
      batchSize: 500
    })
    const result = resolveTaskInput({
      engine: 'pgmigrator',
      action: 'export',
      connectionId: 'src',
      configJson: config,
      vars: {}
    })
    expect('dstConnectionId' in (result.payload as object)).toBe(false)
  })
})

describe('buildStepDescriptors', () => {
  it('returns one step derived from top-level fields for legacy templates', () => {
    const tmpl: MigrationTemplate = makeTemplate({
      steps: []
    })
    const descriptors = buildStepDescriptors(tmpl, { DATE: '2026-09-10' })
    expect(descriptors).toHaveLength(1)
    expect(descriptors[0]!.engine).toBe('pgmigrator')
    expect(descriptors[0]!.connectionName).toBe('pg-prod')
    expect(descriptors[0]!.vars.DATE).toBe('2026-09-10')
  })

  it('returns one step per template step in order', () => {
    const tmpl: MigrationTemplate = makeTemplate({
      steps: [
        {
          id: 'a',
          engine: 'pgmigrator',
          action: 'export',
          connectionName: 'pg',
          configJson: '{"type":"postgres-export"}'
        },
        {
          id: 'b',
          engine: 'esmigrator',
          action: 'import',
          connectionName: 'es',
          configJson: '{"type":"elasticsearch-import"}'
        }
      ]
    })
    const descriptors = buildStepDescriptors(tmpl, {})
    expect(descriptors.map((d) => d.connectionName)).toEqual(['pg', 'es'])
    expect(descriptors.map((d) => d.engine)).toEqual(['pgmigrator', 'esmigrator'])
  })

  it('merges built-in → user → step-level vars with later overriding earlier', () => {
    const tmpl: MigrationTemplate = makeTemplate({
      variables: [{ name: 'X', defaultValue: 'from-template' }],
      steps: [
        {
          id: 'a',
          engine: 'pgmigrator',
          action: 'export',
          connectionName: 'pg',
          configJson: '{}',
          variables: [{ name: 'X', defaultValue: 'from-step' }]
        }
      ]
    })
    const descriptors = buildStepDescriptors(tmpl, { X: 'from-user' })
    expect(descriptors[0]!.vars.X).toBe('from-step')
    expect(descriptors[0]!.vars.TODAY).toBeTruthy()
  })

  it('keeps user vars intact when a step does not override them', () => {
    const tmpl: MigrationTemplate = makeTemplate({
      variables: [{ name: 'TEMPLATE_ONLY', defaultValue: 't' }],
      steps: [
        {
          id: 'a',
          engine: 'pgmigrator',
          action: 'export',
          connectionName: 'pg',
          configJson: '{}',
          variables: [{ name: 'STEP_ONLY', defaultValue: 's' }]
        }
      ]
    })
    const descriptors = buildStepDescriptors(tmpl, { USER: 'u' })
    expect(descriptors[0]!.vars.TEMPLATE_ONLY).toBe('t')
    expect(descriptors[0]!.vars.STEP_ONLY).toBe('s')
    expect(descriptors[0]!.vars.USER).toBe('u')
  })

  it('a step can override the built-in TODAY variable', () => {
    const tmpl: MigrationTemplate = makeTemplate({
      steps: [
        {
          id: 'a',
          engine: 'pgmigrator',
          action: 'export',
          connectionName: 'pg',
          configJson: '{}',
          variables: [{ name: 'TODAY', defaultValue: '1999-01-01' }]
        }
      ]
    })
    const descriptors = buildStepDescriptors(tmpl, {})
    expect(descriptors[0]!.vars.TODAY).toBe('1999-01-01')
  })
})

describe('collectTemplateVariables', () => {
  it('deduplicates template-level and step-level variables by name', () => {
    const tmpl: MigrationTemplate = makeTemplate({
      variables: [
        { name: 'A', defaultValue: '1' },
        { name: 'B', defaultValue: '2' }
      ],
      steps: [
        {
          id: 'a',
          engine: 'pgmigrator',
          action: 'export',
          connectionName: 'pg',
          configJson: '{}',
          variables: [
            { name: 'A', defaultValue: 'override' },
            { name: 'C', defaultValue: '3' }
          ]
        }
      ]
    })
    const collected = collectTemplateVariables(tmpl)
    expect(collected.map((v) => v.name)).toEqual(['A', 'B', 'C'])
    // Template-level declaration wins for duplicate names.
    expect(collected.find((v) => v.name === 'A')?.defaultValue).toBe('1')
  })

  it('falls back to top-level vars when steps is empty', () => {
    const tmpl: MigrationTemplate = makeTemplate({
      steps: [],
      variables: [{ name: 'DATE', defaultValue: '2026-09-10' }]
    })
    expect(collectTemplateVariables(tmpl).map((v) => v.name)).toEqual(['DATE'])
  })
})

function makeTemplate(overrides: Partial<MigrationTemplate>): MigrationTemplate {
  return {
    id: 't1',
    name: 't1',
    engine: 'pgmigrator',
    action: 'export',
    connectionName: 'pg-prod',
    configJson: '{"type":"postgres-export"}',
    variables: [],
    steps: [],
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides
  }
}

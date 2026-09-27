import { describe, expect, it } from 'vitest'

import {
  generateTargetDefinition,
  inferSchemaFromJsonlLines,
  inferSchemaFromRecords,
  inferValueType,
  mergeLogicalTypes,
  withTargetTypes
} from '../src/shared/schema-inference'

describe('schema inference (value types)', () => {
  it('detects scalar logical types', () => {
    expect(inferValueType(true)).toBe('boolean')
    expect(inferValueType(42)).toBe('integer')
    expect(inferValueType(2 ** 60)).toBe('bigint')
    expect(inferValueType(3.5)).toBe('number')
    expect(inferValueType('2026-09-27T12:00:00Z')).toBe('datetime')
    expect(inferValueType('2026-09-27')).toBe('datetime')
    expect(inferValueType('hello')).toBe('string')
    expect(inferValueType({ a: 1 })).toBe('json')
    expect(inferValueType([1, 2])).toBe('json')
    expect(inferValueType(null)).toBeNull()
    expect(inferValueType(undefined)).toBeNull()
    expect(inferValueType(Number.NaN)).toBe('string')
  })

  it('widens numeric types and falls back to string on incompatible mixes', () => {
    expect(mergeLogicalTypes('integer', 'bigint')).toBe('bigint')
    expect(mergeLogicalTypes('bigint', 'number')).toBe('number')
    expect(mergeLogicalTypes('integer', 'number')).toBe('number')
    expect(mergeLogicalTypes('string', 'datetime')).toBe('string')
    expect(mergeLogicalTypes('boolean', 'integer')).toBe('string')
    expect(mergeLogicalTypes('json', 'string')).toBe('string')
  })
})

describe('inferSchemaFromRecords', () => {
  it('infers columns, order, nullability and widening', () => {
    const { columns, scannedRows } = inferSchemaFromRecords([
      { id: 1, name: 'alice', score: 1.5, active: true, meta: { a: 1 } },
      { id: 2, name: 'bob', score: 2, active: false, meta: { a: 2 } },
      { id: 3, name: null, score: 3 }
    ])

    expect(scannedRows).toBe(3)
    expect(columns.map((column) => column.name)).toEqual([
      'id',
      'name',
      'score',
      'active',
      'meta'
    ])
    const byName = new Map(columns.map((column) => [column.name, column]))
    expect(byName.get('id')?.logicalType).toBe('integer')
    expect(byName.get('id')?.nullable).toBe(false)
    expect(byName.get('name')?.nullable).toBe(true)
    expect(byName.get('score')?.logicalType).toBe('number')
    expect(byName.get('active')?.logicalType).toBe('boolean')
    expect(byName.get('meta')?.nullable).toBe(true)
    expect(byName.get('meta')?.logicalType).toBe('json')
  })

  it('treats columns missing from later rows as nullable', () => {
    const { columns } = inferSchemaFromRecords([
      { id: 1, extra: 'x' },
      { id: 2 }
    ])
    const extra = columns.find((column) => column.name === 'extra')
    expect(extra?.nullable).toBe(true)
    expect(extra?.present).toBe(1)
  })
})

describe('target definition generation', () => {
  const columns = withTargetTypes('postgresql', [
    { name: 'id', logicalType: 'integer', nullable: false, present: 1 },
    { name: 'name', logicalType: 'string', nullable: true, present: 1 }
  ])

  it('generates PostgreSQL DDL with quoting and NOT NULL', () => {
    const ddl = generateTargetDefinition('postgresql', 'public', 'orders', columns)
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "public"."orders"')
    expect(ddl).toContain('"id" bigint NOT NULL')
    expect(ddl).toContain('"name" text')
    expect(ddl.trimEnd().endsWith(');')).toBe(true)
  })

  it('generates MySQL DDL with backticks', () => {
    const mysql = withTargetTypes('mysql', [
      { name: 'id', logicalType: 'integer', nullable: false, present: 1 },
      { name: 'flag', logicalType: 'boolean', nullable: true, present: 1 }
    ])
    const ddl = generateTargetDefinition('mysql', 'app', 'orders', mysql)
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS `app`.`orders`')
    expect(ddl).toContain('`id` bigint NOT NULL')
    expect(ddl).toContain('`flag` tinyint(1)')
    expect(ddl).toContain('ENGINE=InnoDB')
  })

  it('generates Hive DDL', () => {
    const hive = withTargetTypes('hive', [
      { name: 'ts', logicalType: 'datetime', nullable: true, present: 1 },
      { name: 'payload', logicalType: 'json', nullable: true, present: 1 }
    ])
    const ddl = generateTargetDefinition('hive', 'dw', 'events', hive)
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS `dw`.`events`')
    expect(ddl).toContain('`ts` timestamp')
    expect(ddl).toContain('`payload` string')
    expect(ddl).toContain('STORED AS TEXTFILE')
  })

  it('generates Elasticsearch mappings JSON', () => {
    const es = withTargetTypes('elasticsearch', [
      { name: 'id', logicalType: 'integer', nullable: false, present: 1 },
      { name: 'name', logicalType: 'string', nullable: true, present: 1 },
      { name: 'when', logicalType: 'datetime', nullable: true, present: 1 }
    ])
    const mapping = JSON.parse(generateTargetDefinition('elasticsearch', undefined, 'logs', es))
    expect(mapping.mappings.properties.id).toEqual({ type: 'long' })
    expect(mapping.mappings.properties.name).toEqual({
      type: 'text',
      fields: { keyword: { type: 'keyword', ignore_above: 256 } }
    })
    expect(mapping.mappings.properties.when).toEqual({ type: 'date' })
  })

  it('rejects empty schemas', () => {
    expect(() => generateTargetDefinition('postgresql', 'public', 'empty', [])).toThrow()
  })
})

describe('inferSchemaFromJsonlLines', () => {
  it('expands batch envelopes and infers per-engine definitions', () => {
    const lines = [
      JSON.stringify({
        table: { schema: 'public', name: 'orders' },
        columns: ['id', 'name', 'score'],
        rows: [
          [1, 'alice', 1.5],
          [2, 'bob', 2]
        ]
      }),
      ''
    ]
    const result = inferSchemaFromJsonlLines(lines, {
      engine: 'postgresql',
      schema: 'public',
      table: 'orders'
    })
    expect(result.scannedRows).toBe(1)
    expect(result.sampledRows).toBe(2)
    expect(result.columns.map((column) => column.name)).toEqual(['id', 'name', 'score'])
    expect(result.columns.find((column) => column.name === 'score')?.logicalType).toBe('number')
    expect(result.definition).toContain('CREATE TABLE IF NOT EXISTS "public"."orders"')
  })

  it('infers Elasticsearch mapping from per-line records', () => {
    const lines = [
      JSON.stringify({ _id: '1', _source: { name: 'a', count: 3 } }),
      JSON.stringify({ _id: '2', _source: { name: 'b', count: 4 } })
    ]
    const result = inferSchemaFromJsonlLines(lines, {
      engine: 'elasticsearch',
      table: 'logs'
    })
    const mapping = JSON.parse(result.definition)
    expect(mapping.mappings.properties.count.type).toBe('long')
    expect(mapping.mappings.properties.name.type).toBe('text')
  })

  it('throws on malformed JSON with a line number', () => {
    expect(() =>
      inferSchemaFromJsonlLines(['{not json'], {
        engine: 'postgresql',
        table: 'orders'
      })
    ).toThrow(/第 1 行/)
  })
})

import { describe, expect, it } from 'vitest'

import type { FieldTransform } from '../src/shared/types'
import {
  transformRecord,
  validateFieldTransforms
} from '../src/shared/type-conversion'

const emptyTargets = new Map<string, string>()

describe('type conversion pipeline', () => {
  it('defaults complex values to JSON strings for text targets', () => {
    const result = transformRecord(
      { payload: { a: 1 } },
      undefined,
      new Map([['payload', 'text']])
    )
    expect(result).toEqual({ payload: '{"a":1}' })
  })

  it('casts array values to delimited text', () => {
    const result = transformRecord(
      { tags: ['a', 'b'] },
      [makeTransform({ strategy: 'cast', sourceType: 'array<string>', targetType: 'text', options: { arrayDelimiter: '|' } })],
      emptyTargets
    )
    expect(result).toEqual({ tags: 'a|b' })
  })

  it('casts map values to JSON text', () => {
    const result = transformRecord(
      { attrs: { a: 1 } },
      [makeTransform({ strategy: 'cast', sourceType: 'map<string,int>', targetType: 'text' })],
      emptyTargets
    )
    expect(result).toEqual({ attrs: '{"a":1}' })
  })

  it('casts non-zero integers to booleans', () => {
    const result = transformRecord(
      { active: 2 },
      [makeTransform({ strategy: 'cast', sourceType: 'int', targetType: 'boolean' })],
      emptyTargets
    )
    expect(result).toEqual({ active: true })
  })

  it('casts ISO strings to normalized timestamps', () => {
    const result = transformRecord(
      { createdAt: '2026-09-17T02:00:00+08:00' },
      [makeTransform({ strategy: 'cast', sourceType: 'iso-string', targetType: 'timestamp' })],
      emptyTargets
    )
    expect(result).toEqual({ createdAt: '2026-09-16T18:00:00.000Z' })
  })

  it('stringifies scalar values', () => {
    const result = transformRecord(
      { id: 42 },
      [makeTransform({ strategy: 'stringify' })],
      emptyTargets
    )
    expect(result).toEqual({ id: '42' })
  })

  it('skips fields without serializing them', () => {
    const result = transformRecord(
      { id: 42, secret: 'x' },
      [makeTransform({ sourceColumn: 'secret', strategy: 'skip' })],
      emptyTargets
    )
    expect(result).toEqual({ id: 42 })
  })

  it('rejects a transform whose source column is absent', () => {
    expect(() =>
      transformRecord(
        { id: 1 },
        [makeTransform({ sourceColumn: 'missing', strategy: 'json' })],
        emptyTargets,
        9
      )
    ).toThrow(/第 9 行.*missing/)
  })
})

describe('validateFieldTransforms', () => {
  it('requires source and target types for cast and validates JSONL columns', () => {
    const missingType = validateFieldTransforms([
      {
        sourceColumn: 'tags',
        sourceType: '',
        targetType: '',
        strategy: 'cast'
      }
    ])
    expect(missingType.errors.join('；')).toContain('sourceType')

    const missingColumn = validateFieldTransforms(
      [
        {
          sourceColumn: 'missing',
          sourceType: 'array<string>',
          targetType: 'text',
          strategy: 'cast'
        }
      ],
      ['tags']
    )
    expect(missingColumn.errors.join('；')).toContain('JSONL 缺少')
  })
})

function makeTransform(
  overrides: Partial<FieldTransform> & Pick<FieldTransform, 'strategy'>
): FieldTransform {
  return {
    sourceColumn: overrides.sourceColumn ?? inferSourceColumn(overrides),
    sourceType: overrides.sourceType ?? '',
    targetType: overrides.targetType ?? '',
    strategy: overrides.strategy,
    ...(overrides.targetColumn ? { targetColumn: overrides.targetColumn } : {}),
    ...(overrides.options ? { options: overrides.options } : {})
  }
}

function inferSourceColumn(transform: Partial<FieldTransform>): string {
  if (transform.sourceType?.startsWith('array')) return 'tags'
  if (transform.sourceType?.startsWith('map')) return 'attrs'
  if (transform.sourceType === 'int') return 'active'
  if (transform.sourceType === 'iso-string') return 'createdAt'
  if (transform.strategy === 'stringify') return 'id'
  return 'payload'
}

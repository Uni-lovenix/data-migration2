import {
  FIELD_TRANSFORM_STRATEGIES,
  type FieldTransform,
  type FieldTransformStrategy
} from './types'

export interface FieldTransformValidationResult {
  value?: FieldTransform[]
  errors: string[]
}

export function validateFieldTransforms(
  value: unknown,
  sourceColumns?: string[]
): FieldTransformValidationResult {
  if (value === undefined || value === null) {
    return { errors: [] }
  }
  if (!Array.isArray(value)) {
    return { errors: ['fieldTransforms 必须是数组'] }
  }
  const errors: string[] = []
  const transforms: FieldTransform[] = []
  const seen = new Set<string>()
  const sourceSet = sourceColumns ? new Set(sourceColumns) : null

  for (const item of value) {
    if (!isRecord(item)) {
      errors.push('fieldTransforms 每一项必须是对象')
      continue
    }
    const sourceColumn =
      typeof item.sourceColumn === 'string' ? item.sourceColumn.trim() : ''
    const sourceType = typeof item.sourceType === 'string' ? item.sourceType.trim() : ''
    const targetType = typeof item.targetType === 'string' ? item.targetType.trim() : ''
    const targetColumn =
      typeof item.targetColumn === 'string' && item.targetColumn.trim().length > 0
        ? item.targetColumn.trim()
        : undefined
    const strategy = item.strategy

    if (sourceColumn.length === 0) {
      errors.push('fieldTransforms.sourceColumn 不能为空')
    }
    if (targetColumn && !isIdentifier(targetColumn)) {
      errors.push(`fieldTransforms.targetColumn 非法：${targetColumn}`)
    }
    if (sourceSet && sourceColumn && !sourceSet.has(sourceColumn)) {
      errors.push(`JSONL 缺少 fieldTransforms.sourceColumn：${sourceColumn}`)
    }
    if (!isStrategy(strategy)) {
      errors.push('fieldTransforms.strategy 必须是 json、cast、stringify 或 skip')
    }
    if (strategy === 'cast' && (sourceType.length === 0 || targetType.length === 0)) {
      errors.push('cast 转换必须提供 sourceType 和 targetType')
    }
    if (sourceColumn && seen.has(sourceColumn)) {
      errors.push(`fieldTransforms.sourceColumn 重复：${sourceColumn}`)
    }
    if (errors.length > 0) {
      continue
    }
    seen.add(sourceColumn)
    transforms.push({
      sourceColumn,
      sourceType,
      targetType,
      strategy: strategy as FieldTransformStrategy,
      ...(targetColumn ? { targetColumn } : {}),
      ...(isRecord(item.options) ? { options: item.options } : {})
    })
  }

  return errors.length > 0 ? { errors } : { value: transforms, errors: [] }
}

export function transformRecord(
  row: Record<string, unknown>,
  transforms: FieldTransform[] | undefined,
  targetTypes: Map<string, string>,
  lineNumber?: number
): Record<string, unknown> {
  const bySource = new Map((transforms ?? []).map((item) => [item.sourceColumn, item]))
  if (transforms) {
    for (const transform of transforms) {
      if (!Object.prototype.hasOwnProperty.call(row, transform.sourceColumn)) {
        const location = lineNumber === undefined ? '' : `第 ${lineNumber} 行`
        throw new Error(
          `${location}缺少 fieldTransforms.sourceColumn：${transform.sourceColumn}`
        )
      }
    }
  }

  const output: Record<string, unknown> = {}
  for (const [sourceColumn, sourceValue] of Object.entries(row)) {
    const transform = bySource.get(sourceColumn)
    if (!transform) {
      const targetType = targetTypes.get(sourceColumn)
      output[sourceColumn] = normalizeTargetValue(
        sourceValue,
        targetType,
        lineNumber,
        sourceColumn,
        describeValueType(sourceValue)
      )
      continue
    }
    if (transform.strategy === 'skip') {
      continue
    }
    const targetColumn = transform.targetColumn ?? sourceColumn
    let converted: unknown
    try {
      converted = convertValue(sourceValue, transform)
    } catch (error) {
      throw conversionError(
        lineNumber,
        sourceColumn,
        transform.sourceType,
        transform.targetType,
        error
      )
    }
    output[targetColumn] = normalizeTargetValue(
      converted,
      targetTypes.get(targetColumn),
      lineNumber,
      targetColumn,
      transform.targetType || transform.sourceType
    )
  }
  return output
}

export function convertValue(value: unknown, transform: FieldTransform): unknown {
  if (value === null || value === undefined) {
    return null
  }
  switch (transform.strategy) {
    case 'json':
      return JSON.stringify(value)
    case 'stringify':
      return String(value)
    case 'skip':
      return undefined
    case 'cast':
      return castValue(value, transform)
  }
}

function castValue(value: unknown, transform: FieldTransform): unknown {
  const sourceType = normalizeType(transform.sourceType)
  const targetType = normalizeType(transform.targetType)

  if (sourceType.startsWith('array<') && isStringType(targetType)) {
    const values = Array.isArray(value) ? value : [value]
    const delimiter =
      typeof transform.options?.arrayDelimiter === 'string'
        ? transform.options.arrayDelimiter
        : ','
    return values.map((item) => String(item)).join(delimiter)
  }
  if (sourceType.startsWith('map<') && isStringType(targetType)) {
    return JSON.stringify(value)
  }
  if (
    (sourceType.includes('int') || sourceType === 'number') &&
    (targetType === 'boolean' || targetType === 'bool')
  ) {
    const number = Number(value)
    if (!Number.isFinite(number)) {
      throw new Error(`无法将 ${String(value)} 转为 boolean`)
    }
    return number !== 0
  }
  if (
    targetType.includes('timestamp') ||
    targetType.includes('datetime') ||
    sourceType.includes('iso') ||
    sourceType.includes('timestamp')
  ) {
    const date = value instanceof Date ? value : new Date(String(value))
    if (Number.isNaN(date.getTime())) {
      throw new Error(`无法将 ${String(value)} 转为 timestamp`)
    }
    return date.toISOString()
  }
  return value
}

function normalizeTargetValue(
  value: unknown,
  targetType: string | undefined,
  lineNumber?: number,
  column?: string,
  sourceType?: string
): unknown {
  if (value === null || value === undefined || !targetType) {
    return value
  }
  const normalizedTarget = normalizeType(targetType)
  try {
    if (isStringType(normalizedTarget)) {
      return isComplexValue(value) ? JSON.stringify(value) : value
    }
    if (isNumericType(normalizedTarget)) {
      if (typeof value === 'bigint') {
        return value.toString()
      }
      if (typeof value === 'boolean') {
        return value ? 1 : 0
      }
      if (
        typeof value !== 'number' &&
        (typeof value !== 'string' || value.trim().length === 0 || !Number.isFinite(Number(value)))
      ) {
        throw new Error('值不是有效数值')
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new Error('值不是有限数值')
      }
      return value
    }
    if (isBooleanType(normalizedTarget)) {
      if (typeof value === 'boolean') {
        return value
      }
      if (value === 0 || value === 1) {
        return value === 1
      }
      if (typeof value === 'string' && /^(true|false|0|1)$/i.test(value)) {
        return value === '1' || value.toLowerCase() === 'true'
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value !== 0
      }
      throw new Error('值不是有效布尔值')
    }
    if (isTemporalType(normalizedTarget)) {
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
          throw new Error('日期值无效')
        }
        return value.toISOString()
      }
      const date = new Date(
        typeof value === 'number' ? value : String(value)
      )
      if (Number.isNaN(date.getTime())) {
        throw new Error('值不是有效日期')
      }
      return date.toISOString()
    }
    if (isJsonType(normalizedTarget)) {
      if (typeof value !== 'string') {
        return JSON.stringify(value)
      }
      try {
        JSON.parse(value)
        return value
      } catch {
        return JSON.stringify(value)
      }
    }
    return value
  } catch (error) {
    throw conversionError(
      lineNumber,
      column ?? '',
      sourceType ?? describeValueType(value),
      targetType,
      error
    )
  }
}

function conversionError(
  lineNumber: number | undefined,
  column: string,
  sourceType: string,
  targetType: string,
  error: unknown
): Error {
  const location = lineNumber === undefined ? '' : `第 ${lineNumber} 行`
  const field = column.length > 0 ? `字段 ${column}` : '字段'
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(
    `${location}${field} 转换失败（${sourceType || 'unknown'} -> ${targetType || 'unknown'}）：${detail}`
  )
}

function describeValueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (value instanceof Date) return 'date'
  if (typeof value === 'object') return 'object'
  return typeof value
}

function isComplexValue(value: unknown): boolean {
  return Array.isArray(value) || (typeof value === 'object' && value !== null)
}

function normalizeType(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function isStringType(value: string): boolean {
  return (
    value === 'string' ||
    value === 'text' ||
    value === 'character' ||
    value === 'character varying' ||
    value.startsWith('varchar') ||
    value.startsWith('char') ||
    value.startsWith('nvarchar')
  )
}

function isNumericType(value: string): boolean {
  return (
    /^(tinyint|smallint|mediumint|integer|bigint|int|int2|int4|int8)(\b|\()/.test(value) ||
    value.startsWith('numeric') ||
    value.startsWith('decimal') ||
    value.startsWith('real') ||
    value.startsWith('money') ||
    value.startsWith('double') ||
    value.startsWith('float') ||
    value === 'number'
  )
}

function isBooleanType(value: string): boolean {
  return value === 'boolean' || value === 'bool'
}

function isTemporalType(value: string): boolean {
  return (
    value.includes('timestamp') ||
    value === 'date' ||
    value.includes('datetime')
  )
}

function isJsonType(value: string): boolean {
  return value === 'json' || value === 'jsonb'
}

function isStrategy(value: unknown): value is FieldTransformStrategy {
  return (
    typeof value === 'string' &&
    (FIELD_TRANSFORM_STRATEGIES as readonly string[]).includes(value)
  )
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

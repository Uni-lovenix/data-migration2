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
      output[sourceColumn] = shouldDefaultJson(sourceValue, targetType)
        ? JSON.stringify(sourceValue)
        : sourceValue
      continue
    }
    if (transform.strategy === 'skip') {
      continue
    }
    const targetColumn = transform.targetColumn ?? sourceColumn
    output[targetColumn] = convertValue(sourceValue, transform)
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

function shouldDefaultJson(value: unknown, targetType: string | undefined): boolean {
  if (!targetType || !isStringType(normalizeType(targetType))) {
    return false
  }
  return Array.isArray(value) || (typeof value === 'object' && value !== null)
}

function normalizeType(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function isStringType(value: string): boolean {
  return (
    value === 'string' ||
    value === 'text' ||
    value.startsWith('varchar') ||
    value.startsWith('char') ||
    value.startsWith('nvarchar')
  )
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

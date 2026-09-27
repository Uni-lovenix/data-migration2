/**
 * 导入数据类型推断与目标 schema/mapping 生成。
 *
 * 设计目标：导入时不再强依赖"目标表/索引预先存在"，而是扫描 JSONL 样本，
 * 按数据实际类型推断列与逻辑类型，再生成目标端可执行的定义：
 * - SQL 目标端（PostgreSQL / MySQL / Hive）：生成 `CREATE TABLE` DDL；
 * - Elasticsearch：生成 index `mappings`。
 *
 * 推断只做保守的类型提升（数值互相兼容，其余混合类型回退为字符串），
 * 生成的 DDL/mapping 在 UI 中可人工重定义后再创建导入。
 */

import type {
  InferredColumn,
  InferredLogicalType,
  SchemaInferenceRequest,
  SchemaInferenceResult
} from './types'
import { expandJsonlRecord } from './jsonl-record'

export const LOGICAL_TYPES: InferredLogicalType[] = [
  'boolean',
  'integer',
  'bigint',
  'number',
  'datetime',
  'string',
  'json'
]

const NUMERIC_RANK: Partial<Record<InferredLogicalType, number>> = {
  integer: 1,
  bigint: 2,
  number: 3
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 推断单个 JSON 值的逻辑类型。
 * 返回 `null` 表示缺失/null（由调用方记录可空性，不参与类型提升）。
 */
export function inferValueType(value: unknown): InferredLogicalType | null {
  if (value === null || value === undefined) {
    return null
  }
  switch (typeof value) {
    case 'boolean':
      return 'boolean'
    case 'bigint':
      return 'bigint'
    case 'number':
      if (!Number.isFinite(value)) {
        return 'string'
      }
      if (!Number.isInteger(value)) {
        return 'number'
      }
      return Number.isSafeInteger(value) ? 'integer' : 'bigint'
    case 'string':
      return ISO_DATE_TIME.test(value) || ISO_DATE.test(value) ? 'datetime' : 'string'
    case 'object':
      return 'json'
    default:
      return 'string'
  }
}

/** 合并同一列在不同行上的逻辑类型。 */
export function mergeLogicalTypes(
  left: InferredLogicalType,
  right: InferredLogicalType
): InferredLogicalType {
  if (left === right) {
    return left
  }
  const leftRank = NUMERIC_RANK[left]
  const rightRank = NUMERIC_RANK[right]
  if (leftRank !== undefined && rightRank !== undefined) {
    return leftRank >= rightRank ? left : right
  }
  // 数值与字符串混排（含布尔与数值混排）时回退为字符串，保证任意值都能写入。
  return 'string'
}

interface ColumnAccumulator {
  logicalType: InferredLogicalType | null
  nullable: boolean
  present: number
}

/**
 * 从已展开的记录（`Record{Values}` 流）推断列与逻辑类型。
 * 列顺序按首次出现顺序排列；只有从未缺失且从未为 null 的列才标记为非空。
 */
export function inferSchemaFromRecords(records: Array<Record<string, unknown>>): {
  columns: Array<Omit<InferredColumn, 'targetType'>>
  scannedRows: number
} {
  const order: string[] = []
  const accumulators = new Map<string, ColumnAccumulator>()

  for (const record of records) {
    const keys = new Set(Object.keys(record))
    for (const key of keys) {
      if (!accumulators.has(key)) {
        order.push(key)
        accumulators.set(key, { logicalType: null, nullable: false, present: 0 })
      }
    }
    // 采样中缺失的列标记为可空（避免生成 NOT NULL 导致导入失败）。
    for (const key of accumulators.keys()) {
      if (!keys.has(key)) {
        const accumulator = accumulators.get(key)
        if (accumulator) {
          accumulator.nullable = true
        }
      }
    }
    for (const [key, value] of Object.entries(record)) {
      const accumulator = accumulators.get(key)
      if (!accumulator) {
        continue
      }
      accumulator.present += 1
      const valueType = inferValueType(value)
      if (valueType === null) {
        accumulator.nullable = true
        continue
      }
      accumulator.logicalType = accumulator.logicalType
        ? mergeLogicalTypes(accumulator.logicalType, valueType)
        : valueType
    }
  }

  const columns = order.map((name) => {
    const accumulator = accumulators.get(name) ?? {
      logicalType: null,
      nullable: true,
      present: 0
    }
    return {
      name,
      // 全为 null 的列退化为字符串（无法确定更具体的类型）。
      logicalType: accumulator.logicalType ?? 'string',
      nullable: accumulator.nullable || accumulator.present < records.length,
      present: accumulator.present
    }
  })

  return { columns, scannedRows: records.length }
}

const TARGET_TYPES: Record<SchemaInferenceRequest['engine'], Record<InferredLogicalType, string>> = {
  postgresql: {
    boolean: 'boolean',
    integer: 'bigint',
    bigint: 'bigint',
    number: 'double precision',
    datetime: 'timestamptz',
    string: 'text',
    json: 'jsonb'
  },
  mysql: {
    boolean: 'tinyint(1)',
    integer: 'bigint',
    bigint: 'bigint',
    number: 'double',
    datetime: 'datetime(6)',
    string: 'text',
    json: 'json'
  },
  hive: {
    boolean: 'boolean',
    integer: 'bigint',
    bigint: 'bigint',
    number: 'double',
    datetime: 'timestamp',
    string: 'string',
    json: 'string'
  },
  elasticsearch: {
    boolean: 'boolean',
    integer: 'long',
    bigint: 'long',
    number: 'double',
    datetime: 'date',
    string: 'text',
    json: 'object'
  }
}

export function targetTypeFor(
  engine: SchemaInferenceRequest['engine'],
  logicalType: InferredLogicalType
): string {
  return TARGET_TYPES[engine][logicalType]
}

/** 为每列补充目标端类型名。 */
export function withTargetTypes(
  engine: SchemaInferenceRequest['engine'],
  columns: Array<Omit<InferredColumn, 'targetType'>>
): InferredColumn[] {
  return columns.map((column) => ({
    ...column,
    targetType: targetTypeFor(engine, column.logicalType)
  }))
}

function quotePostgres(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function quoteBacktick(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``
}

function qualified(quote: (value: string) => string, schema: string | undefined, table: string): string {
  const trimmedSchema = schema?.trim()
  return trimmedSchema ? `${quote(trimmedSchema)}.${quote(table)}` : quote(table)
}

function generateSqlDdl(
  engine: Exclude<SchemaInferenceRequest['engine'], 'elasticsearch'>,
  schema: string | undefined,
  table: string,
  columns: InferredColumn[]
): string {
  const quote = engine === 'postgresql' ? quotePostgres : quoteBacktick
  const target = qualified(quote, schema, table)
  const body = columns
    .map((column) => {
      const nullability = column.nullable ? '' : ' NOT NULL'
      return `  ${quote(column.name)} ${column.targetType}${nullability}`
    })
    .join(',\n')
  const suffix =
    engine === 'mysql'
      ? '\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;'
      : engine === 'hive'
        ? '\n)\nSTORED AS TEXTFILE;'
        : '\n);'
  return `CREATE TABLE IF NOT EXISTS ${target} (\n${body}${suffix}`
}

function generateEsMapping(columns: InferredColumn[]): string {
  const properties: Record<string, unknown> = {}
  for (const column of columns) {
    if (column.logicalType === 'string') {
      // 与 Elasticsearch 动态映射保持一致：text + keyword 子字段，兼顾全文与精确匹配。
      properties[column.name] = {
        type: 'text',
        fields: { keyword: { type: 'keyword', ignore_above: 256 } }
      }
    } else if (column.logicalType === 'json') {
      properties[column.name] = { type: 'object', enabled: true }
    } else {
      properties[column.name] = { type: column.targetType }
    }
  }
  return JSON.stringify({ mappings: { properties } }, null, 2)
}

/** 生成目标端定义（SQL DDL 或 Elasticsearch mapping JSON）。 */
export function generateTargetDefinition(
  engine: SchemaInferenceRequest['engine'],
  schema: string | undefined,
  table: string,
  columns: InferredColumn[]
): string {
  if (columns.length === 0) {
    throw new Error('没有可推断的列，无法生成目标定义')
  }
  if (engine === 'elasticsearch') {
    return generateEsMapping(columns)
  }
  return generateSqlDdl(engine, schema, table, columns)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 目标端归一化：Elasticsearch 导出的逐行记录形如 `{_id, _source}`，
 * 推断目标 mapping 时应基于 `_source`（文档体）而不是外层信封。
 */
function normalizeRecordForEngine(
  engine: SchemaInferenceRequest['engine'],
  record: Record<string, unknown>
): Record<string, unknown> {
  if (engine !== 'elasticsearch') {
    return record
  }
  const source = record._source
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    return source as Record<string, unknown>
  }
  return record
}

/**
 * 从 JSONL 文本行推断 schema 并生成目标定义。
 *
 * `lines` 是文件内容行（可包含批次信封）；`sampleSize` 限制参与推断的记录数。
 */
export function inferSchemaFromJsonlLines(
  lines: string[],
  request: Pick<SchemaInferenceRequest, 'engine' | 'schema' | 'table' | 'sampleSize'>
): SchemaInferenceResult {
  const sampleSize = Math.max(1, request.sampleSize ?? 1000)
  const records: Array<Record<string, unknown>> = []
  let scannedRows = 0
  for (let index = 0; index < lines.length && records.length < sampleSize; index += 1) {
    const line = lines[index]
    if (line === undefined || line.trim().length === 0) {
      continue
    }
    scannedRows += 1
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`第 ${index + 1} 行不是有效 JSON：${line.slice(0, 120)}`)
    }
    let expanded: Array<Record<string, unknown>>
    try {
      expanded = expandJsonlRecord(parsed, index + 1)
    } catch (error) {
      throw new Error(errorMessage(error))
    }
    for (const record of expanded) {
      if (records.length >= sampleSize) {
        break
      }
      records.push(normalizeRecordForEngine(request.engine, record))
    }
  }

  const { columns } = inferSchemaFromRecords(records)
  const resolved = withTargetTypes(request.engine, columns)
  return {
    columns: resolved,
    definition: generateTargetDefinition(request.engine, request.schema, request.table, resolved),
    scannedRows,
    sampledRows: records.length
  }
}

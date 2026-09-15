/**
 * 统一中间格式（Normalize 层）的 JSONL 解析辅助。
 *
 * 引擎约定：JSONL 文件是 Source → Sink 之间的唯一中间格式。Source 落地时允许两种行长：
 *
 * 1) 逐行记录（PG / ES 导出器的行长）：
 *    每行一个 `Record{Values}`，即 `{ column: value, ... }`。
 *
 * 2) 批次信封（MySQL / Hive 等按批落盘的 Source）：
 *    每行一个 `{ table: {schema, name}, columns: string[], rows: unknown[][] }`，
 *    其中 `rows` 是二维值数组，每项与 `columns` 逐列对齐。
 *
 * Sink 侧统一通过 `expandJsonlRecord` 把两种行长都归一化为 `Record{Values}` 流，
 * 从而保证「任意 Source 导出的 JSONL 可被任意 Sink 直接消费」——
 * 这是 goals.md 目标 6（数据在不同数据库之间流动）的引擎层基础。
 */

/** 批次信封中的表标识（schema 字段在 MySQL 中承载 database 名）。 */
export interface JsonlRecordBatchTable {
  schema?: string
  name?: string
}

/** 归一化后的批次信封（Record 批）。 */
export interface JsonlRecordBatch {
  table?: JsonlRecordBatchTable
  columns: string[]
  rows: unknown[][]
}

/**
 * 判断是否为批次信封：`columns` 与 `rows` 同时为数组。
 *
 * 只有两个字段同时是数组才判定为信封，避免把「恰好有一个名为 columns 的 JSON 列」的普通行误判。
 */
function looksLikeRecordBatch(value: Record<string, unknown>): boolean {
  return Array.isArray(value.columns) && Array.isArray(value.rows)
}

/** 严格校验批次信封的形状（列名必须全为字符串、每行列数必须与列名数量一致）。 */
export function isJsonlRecordBatch(value: unknown): value is JsonlRecordBatch {
  if (!isJsonObject(value) || !looksLikeRecordBatch(value)) {
    return false
  }
  const columns = value.columns as unknown[]
  const rows = value.rows as unknown[]
  if (!columns.every((column) => typeof column === 'string')) {
    return false
  }
  return rows.every((row) => Array.isArray(row) && row.length === columns.length)
}

/**
 * 把一行 JSONL 展开为若干条 `Record{Values}`（列名 → 值）。
 *
 * - 逐行记录：原样透传（返回单元素数组）。
 * - 批次信封：按 `columns` 把 `rows` 的每个值数组还原为对象。
 *
 * 展开失败时抛出带行号的错误，方便任务日志定位到具体 JSONL 行。
 */
export function expandJsonlRecord(
  value: unknown,
  lineNumber: number
): Array<Record<string, unknown>> {
  if (!isJsonObject(value)) {
    throw new Error(`第 ${lineNumber} 行必须是 JSON 对象`)
  }

  if (!looksLikeRecordBatch(value)) {
    return [value]
  }

  const columns = value.columns as unknown[]
  const rows = value.rows as unknown[]
  if (!columns.every((column) => typeof column === 'string')) {
    throw new Error(`第 ${lineNumber} 行的 columns 必须是字符串数组`)
  }

  return rows.map((row, index) => {
    if (!Array.isArray(row)) {
      throw new Error(`第 ${lineNumber} 行 rows[${index}] 必须是数组`)
    }
    if (row.length !== columns.length) {
      throw new Error(
        `第 ${lineNumber} 行 rows[${index}] 的值数量（${row.length}）与 columns（${columns.length}）不一致`
      )
    }
    const record: Record<string, unknown> = {}
    columns.forEach((column, columnIndex) => {
      record[column as string] = row[columnIndex]
    })
    return record
  })
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

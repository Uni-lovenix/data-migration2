export function assertSelectedColumnsPresent(
  sourceColumns: string[],
  selectedColumns: string[] | undefined,
  lineNumber: number
): void {
  if (!selectedColumns || selectedColumns.length === 0) {
    return
  }
  const source = new Set(sourceColumns)
  const missing = selectedColumns.filter((column) => !source.has(column))
  if (missing.length > 0) {
    throw new Error(
      `第 ${lineNumber} 行缺少 selectedColumns：${missing.join(', ')}`
    )
  }
}

export function projectRecord(
  row: Record<string, unknown>,
  selectedColumns: string[] | undefined
): Record<string, unknown> {
  if (!selectedColumns || selectedColumns.length === 0) {
    return row
  }
  const selected = new Set(selectedColumns)
  const projected: Record<string, unknown> = {}
  // Keep source order so positional SQL mappings stay aligned with JSONL columns.
  for (const column of Object.keys(row)) {
    if (selected.has(column)) {
      projected[column] = row[column]
    }
  }
  return projected
}

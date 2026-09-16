import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { CheckSquare, Loader2, Square } from 'lucide-react'

interface ColumnSelectionProps {
  inputFile: string
  selectedColumns: string[]
  onChange: (columns: string[]) => void
}

export function ColumnSelection({
  inputFile,
  selectedColumns,
  onChange
}: ColumnSelectionProps): ReactElement | null {
  const [columns, setColumns] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!inputFile) {
      setColumns([])
      setError(null)
      return
    }
    let disposed = false
    setLoading(true)
    setError(null)
    window.api.fs
      .jsonlColumns(inputFile)
      .then((nextColumns) => {
        if (disposed) {
          return
        }
        setColumns(nextColumns)
        const valid = selectedColumns.filter((column) => nextColumns.includes(column))
        onChange(valid.length > 0 ? valid : nextColumns)
      })
      .catch((cause) => {
        if (!disposed) {
          setColumns([])
          setError(cause instanceof Error ? cause.message : '读取 JSONL 列失败')
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false)
        }
      })
    return () => {
      disposed = true
    }
  }, [inputFile])

  if (!inputFile) {
    return null
  }

  return (
    <div className="field">
      <label>字段选择</label>
      {loading ? (
        <div className="field-row">
          <Loader2 className="spin" size={14} />
          <span className="field-hint">正在读取 JSONL 列…</span>
        </div>
      ) : error ? (
        <div className="inline-error">{error}</div>
      ) : (
        <>
          <div className="table-picker column-picker">
            {columns.map((column) => (
              <label key={column} className="table-picker-row">
                <input
                  type="checkbox"
                  checked={selectedColumns.includes(column)}
                  onChange={() =>
                    onChange(
                      selectedColumns.includes(column)
                        ? selectedColumns.filter((item) => item !== column)
                        : [...selectedColumns, column]
                    )
                  }
                />
                <span className="table-picker-name">{column}</span>
              </label>
            ))}
          </div>
          <div className="table-picker-actions">
            <button
              type="button"
              className="button button-secondary button-small"
              disabled={columns.length === 0}
              onClick={() => onChange(columns)}
            >
              <CheckSquare size={14} />
              全选
            </button>
            <button
              type="button"
              className="button button-secondary button-small"
              disabled={selectedColumns.length === 0}
              onClick={() => onChange([])}
            >
              <Square size={14} />
              清空
            </button>
            <span className="badge">
              {selectedColumns.length}/{columns.length} 列
            </span>
          </div>
        </>
      )}
    </div>
  )
}

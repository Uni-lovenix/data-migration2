import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Plus, Trash2 } from 'lucide-react'

import type { FieldTransform, FieldTransformStrategy } from '../../../shared/types'

interface FieldTransformsEditorProps {
  inputFile: string
  transforms: FieldTransform[]
  onChange: (transforms: FieldTransform[]) => void
}

export function FieldTransformsEditor({
  inputFile,
  transforms,
  onChange
}: FieldTransformsEditorProps): ReactElement | null {
  const [columns, setColumns] = useState<string[]>([])

  useEffect(() => {
    if (!inputFile) {
      setColumns([])
      return
    }
    let disposed = false
    window.api.fs
      .jsonlColumns(inputFile)
      .then((nextColumns) => {
        if (!disposed) {
          setColumns(nextColumns)
        }
      })
      .catch(() => {
        if (!disposed) {
          setColumns([])
        }
      })
    return () => {
      disposed = true
    }
  }, [inputFile])

  if (!inputFile) {
    return null
  }

  function update(index: number, patch: Partial<FieldTransform>): void {
    onChange(
      transforms.map((transform, current) =>
        current === index ? { ...transform, ...patch } : transform
      )
    )
  }

  return (
    <details className="help field-transforms">
      <summary>字段转换</summary>
      <div className="field-transforms-body">
        {transforms.map((transform, index) => (
          <div className="transform-row" key={`${transform.sourceColumn}-${index}`}>
            <select
              value={transform.sourceColumn}
              onChange={(event) =>
                update(index, { sourceColumn: event.target.value })
              }
              aria-label="源字段"
            >
              <option value="">源字段</option>
              {columns.map((column) => (
                <option key={column} value={column}>
                  {column}
                </option>
              ))}
            </select>
            <input
              value={transform.sourceType}
              onChange={(event) =>
                update(index, { sourceType: event.target.value })
              }
              placeholder="源类型，如 array<string>"
              aria-label="源类型"
            />
            <input
              value={transform.targetColumn ?? ''}
              onChange={(event) =>
                update(index, { targetColumn: event.target.value || undefined })
              }
              placeholder="目标字段（可选）"
              aria-label="目标字段"
            />
            <input
              value={transform.targetType}
              onChange={(event) =>
                update(index, { targetType: event.target.value })
              }
              placeholder="目标类型，如 text"
              aria-label="目标类型"
            />
            <select
              value={transform.strategy}
              onChange={(event) =>
                update(index, {
                  strategy: event.target.value as FieldTransformStrategy
                })
              }
              aria-label="转换策略"
            >
              <option value="json">json</option>
              <option value="cast">cast</option>
              <option value="stringify">stringify</option>
              <option value="skip">skip</option>
            </select>
            {transform.strategy === 'cast' ? (
              <input
                value={
                  typeof transform.options?.arrayDelimiter === 'string'
                    ? transform.options.arrayDelimiter
                    : ''
                }
                onChange={(event) =>
                  update(index, {
                    options: event.target.value
                      ? { arrayDelimiter: event.target.value }
                      : undefined
                  })
                }
                placeholder="数组分隔符"
                aria-label="数组分隔符"
              />
            ) : null}
            <button
              type="button"
              className="icon-button"
              aria-label="删除转换"
              onClick={() =>
                onChange(transforms.filter((_item, current) => current !== index))
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button button-secondary button-small"
          onClick={() =>
            onChange([
              ...transforms,
              {
                sourceColumn: columns[0] ?? '',
                sourceType: '',
                targetType: '',
                strategy: 'json'
              }
            ])
          }
        >
          <Plus size={14} />
          添加转换
        </button>
      </div>
    </details>
  )
}

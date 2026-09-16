import { useState } from 'react'
import type { DragEvent, ReactElement } from 'react'
import { GripVertical, Loader2, Play, Plus, Trash2 } from 'lucide-react'

import type {
  OrchestrationResult,
  OrchestrationStep
} from '../../../shared/types'

interface EditableStep {
  id: string
  atom: string
  argsText: string
}

const DEFAULT_ARGS: Record<string, Record<string, unknown>> = {
  export_preview: {
    source: 'postgresql',
    connectionId: '',
    limit: 20,
    table: { schema: 'public', name: 'users' }
  },
  import_validate: {
    target: 'postgresql',
    connectionId: '',
    table: { schema: 'public', name: 'users' },
    columns: ['id', 'name']
  },
  cast_dry_run: {
    row: { active: 1 },
    transforms: []
  },
  task_create: {
    input: {
      type: 'postgres-export',
      payload: {
        connectionId: '',
        table: { schema: 'public', name: 'users' },
        outputFile: '/tmp/users.jsonl',
        batchSize: 1000
      }
    }
  }
}

export function OrchestrationPanel(): ReactElement {
  const [steps, setSteps] = useState<EditableStep[]>([
    makeStep('export_preview')
  ])
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<OrchestrationResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run(): Promise<void> {
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const parsed: OrchestrationStep[] = steps.map((step) => ({
        atom: step.atom,
        ...(JSON.parse(step.argsText) as Record<string, unknown>)
      }))
      setResult(await window.api.orchestration.run(parsed))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '编排执行失败')
    } finally {
      setRunning(false)
    }
  }

  function dropAt(index: number): void {
    if (dragIndex === null || dragIndex === index) {
      return
    }
    setSteps((current) => {
      const next = [...current]
      const [moved] = next.splice(dragIndex, 1)
      if (moved) {
        next.splice(index, 0, moved)
      }
      return next
    })
    setDragIndex(null)
  }

  return (
    <>
      <div className="toolbar">
        <span className="badge">原子编排 beta</span>
        <button
          type="button"
          className="button button-secondary button-small"
          onClick={() => setSteps((current) => [...current, makeStep('cast_dry_run')])}
        >
          <Plus size={14} />
          添加步骤
        </button>
      </div>
      <div className="orchestration-layout">
        <section className="section migration-section">
          <div className="section-heading">
            <h2>执行计划</h2>
            <span className="badge">{steps.length} 步</span>
          </div>
          <div className="migration-body">
            {steps.map((step, index) => (
              <div
                className="orchestration-step"
                key={step.id}
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragOver={(event: DragEvent) => event.preventDefault()}
                onDrop={() => dropAt(index)}
              >
                <GripVertical size={16} />
                <select
                  value={step.atom}
                  onChange={(event) => {
                    const atom = event.target.value
                    setSteps((current) =>
                      current.map((item, currentIndex) =>
                        currentIndex === index ? makeStep(atom, item.id) : item
                      )
                    )
                  }}
                >
                  <option value="export_preview">export_preview</option>
                  <option value="import_validate">import_validate</option>
                  <option value="cast_dry_run">cast_dry_run</option>
                  <option value="task_create">task_create</option>
                </select>
                <textarea
                  className="code-textarea"
                  rows={5}
                  value={step.argsText}
                  onChange={(event) =>
                    setSteps((current) =>
                      current.map((item, currentIndex) =>
                        currentIndex === index
                          ? { ...item, argsText: event.target.value }
                          : item
                      )
                    )
                  }
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label="删除步骤"
                  onClick={() =>
                    setSteps((current) =>
                      current.filter((_item, currentIndex) => currentIndex !== index)
                    )
                  }
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="section migration-section">
          <div className="section-heading">
            <h2>运行与结果</h2>
            <span className="badge">线性</span>
          </div>
          <div className="migration-body">
            <button
              type="button"
              className="button button-primary"
              disabled={running || steps.length === 0}
              onClick={() => void run()}
            >
              {running ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
              运行编排
            </button>
            {error ? <div className="inline-error">{error}</div> : null}
            {result ? (
              <>
                <div className="field-row">
                  <span className="badge badge-ok">{result.summary.completed} 完成</span>
                  <span className="badge">{result.summary.failed} 失败</span>
                  <span className="badge">{result.summary.skipped} 跳过</span>
                </div>
                <pre className="code-block">
                  {JSON.stringify(result, null, 2)}
                </pre>
              </>
            ) : null}
          </div>
        </section>
      </div>
    </>
  )
}

function makeStep(atom: string, id: string = crypto.randomUUID()): EditableStep {
  return {
    id,
    atom,
    argsText: JSON.stringify(DEFAULT_ARGS[atom] ?? {}, null, 2)
  }
}

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  CheckCircle2,
  ListChecks,
  Loader2,
  Play,
  Square,
  XCircle
} from 'lucide-react'

import type { MigrationTask, MigrationTaskPayload } from '../../../shared/types'

export function TasksPage(): ReactElement {
  const [tasks, setTasks] = useState<MigrationTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    window.api.tasks
      .list()
      .then((nextTasks) => {
        if (!disposed) {
          setTasks(nextTasks)
        }
      })
      .catch((cause) => {
        if (!disposed) {
          setError(errorMessage(cause))
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false)
        }
      })

    const unsubscribe = window.api.tasks.onChanged((task) => {
      if (disposed) {
        return
      }
      setTasks((current) => {
        const index = current.findIndex((item) => item.id === task.id)
        if (index < 0) {
          return [task, ...current]
        }
        const next = [...current]
        next[index] = task
        return next
      })
    })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  async function handleCancel(id: string): Promise<void> {
    setError(null)
    try {
      await window.api.tasks.cancel(id)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function handleResume(id: string): Promise<void> {
    setError(null)
    try {
      await window.api.tasks.resume(id)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>任务</h1>
          <p>后台迁移任务、进度与续传</p>
        </div>
        <span className="badge">{tasks.length} 个任务</span>
      </div>

      {error ? <div className="inline-error">{error}</div> : null}

      <div className="table-card">
        {loading ? (
          <div className="table-empty">
            <Loader2 className="spin" size={30} />
            <span>加载任务中…</span>
          </div>
        ) : tasks.length === 0 ? (
          <div className="table-empty">
            <ListChecks size={30} />
            <span>还没有迁移任务</span>
            <span className="table-empty-hint">从迁移工作台发起导出或导入后会出现在这里</span>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>任务</th>
                <th>目标</th>
                <th>状态</th>
                <th>进度</th>
                <th>创建时间</th>
                <th className="actions-column">操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id}>
                  <td>
                    <div className="cell-name">{taskTypeLabel(task.type)}</div>
                    <div className="cell-sub">{task.id.slice(0, 8)}</div>
                  </td>
                  <td>
                    <code>{taskTarget(task.payload)}</code>
                  </td>
                  <td>
                    <span className={`badge task-status-${task.status}`}>
                      {taskStatusLabel(task.status)}
                    </span>
                  </td>
                  <td>
                    <div className="task-progress">
                      <div className="progress-track">
                        <div
                          className={`progress-fill ${
                            task.status === 'running' ? 'progress-fill-running' : ''
                          } ${task.status === 'completed' ? 'progress-fill-done' : ''}`}
                          style={{
                            width:
                              task.status === 'completed'
                                ? '100%'
                                : task.status === 'running'
                                  ? '45%'
                                  : '12%'
                          }}
                        />
                      </div>
                      <span>{task.progress.toLocaleString()}</span>
                    </div>
                    {task.error ? <div className="task-error">{task.error}</div> : null}
                  </td>
                  <td className="cell-muted">{formatDateTime(task.createdAt)}</td>
                  <td className="actions-column">
                    {task.status === 'queued' || task.status === 'running' ? (
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        onClick={() => void handleCancel(task.id)}
                      >
                        <Square size={14} />
                        取消
                      </button>
                    ) : null}
                    {task.status === 'paused' ||
                    task.status === 'failed' ||
                    task.status === 'canceled' ? (
                      <button
                        type="button"
                        className="button button-primary button-small"
                        onClick={() => void handleResume(task.id)}
                      >
                        <Play size={14} />
                        继续
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {tasks.some((task) => task.status === 'failed' || task.status === 'canceled') ? (
        <div className="task-legend">
          <span>
            <XCircle size={14} />
            取消或失败的任务保留游标，可点击“继续”断点续传
          </span>
          <span>
            <CheckCircle2 size={14} />
            完成状态会持久化到本地 SQLite
          </span>
        </div>
      ) : null}
    </div>
  )
}

function taskTypeLabel(type: MigrationTask['type']): string {
  switch (type) {
    case 'postgres-export':
      return 'PostgreSQL 导出'
    case 'postgres-export-batch':
      return 'PostgreSQL 多表导出'
    case 'postgres-import':
      return 'PostgreSQL 导入'
    case 'elasticsearch-export':
      return 'Elasticsearch 导出'
    case 'elasticsearch-import':
      return 'Elasticsearch 导入'
  }
}

function taskTarget(payload: MigrationTaskPayload): string {
  if ('tables' in payload) {
    return `${payload.tables.length} 张表`
  }
  if ('table' in payload) {
    return `${payload.table.schema}.${payload.table.name}`
  }
  if ('index' in payload) {
    return payload.index
  }
  return ''
}

function taskStatusLabel(status: MigrationTask['status']): string {
  switch (status) {
    case 'queued':
      return '排队中'
    case 'running':
      return '运行中'
    case 'paused':
      return '已暂停'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'canceled':
      return '已取消'
  }
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '任务操作失败'
}

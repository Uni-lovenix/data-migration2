import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import {
  CheckCircle2,
  FilePlus,
  ListChecks,
  Loader2,
  Play,
  Square,
  X,
  XCircle
} from 'lucide-react'

import type {
  ConnectionConfig,
  MigrationTask,
  MigrationTaskPayload,
  ViewKey
} from '../../../shared/types'
import {
  DATA_DIR_VARIABLE,
  TasksToTemplateDraftError,
  tasksToTemplateDraft
} from '../../../shared/template-from-tasks'

interface TasksPageProps {
  connections: ConnectionConfig[]
  onNavigate: (view: ViewKey) => void
}

export function TasksPage({ connections, onNavigate }: TasksPageProps): ReactElement {
  const [tasks, setTasks] = useState<MigrationTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Ordered list of selected task ids. Order matters: it's the order the
  // template will execute its steps in. "Click order" semantics: clicking a
  // checkbox appends; clicking again removes. Select-all pushes in the order
  // the table currently displays.
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [saveModalOpen, setSaveModalOpen] = useState(false)

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

  // Drop any selected ids that have left the list (e.g. the user deleted a
  // connection upstream and the corresponding tasks are no longer returned).
  useEffect(() => {
    const present = new Set(tasks.map((t) => t.id))
    setSelectedIds((prev) => {
      const filtered = prev.filter((id) => present.has(id))
      return filtered.length === prev.length ? prev : filtered
    })
  }, [tasks])

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

  function toggleSelect(id: string): void {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id]
    )
  }

  function toggleSelectAll(): void {
    setSelectedIds((prev) =>
      prev.length === tasks.length ? [] : tasks.map((t) => t.id)
    )
  }

  const selectedTasks = useMemo(
    () =>
      selectedIds
        .map((id) => tasks.find((task) => task.id === id))
        .filter((task): task is MigrationTask => task !== undefined),
    [selectedIds, tasks]
  )

  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>任务</h1>
          <p>后台迁移任务、进度与续传</p>
        </div>
        <div className="page-heading-actions">
          {selectedTasks.length > 0 ? (
            <button
              type="button"
              className="button button-primary"
              onClick={() => setSaveModalOpen(true)}
            >
              <FilePlus size={16} />
              保存为模板 ({selectedTasks.length})
            </button>
          ) : null}
          <span className="badge">{tasks.length} 个任务</span>
        </div>
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
                <th className="checkbox-column">
                  <input
                    type="checkbox"
                    checked={
                      tasks.length > 0 && selectedIds.length === tasks.length
                    }
                    onChange={toggleSelectAll}
                    aria-label="全选"
                  />
                </th>
                <th>任务</th>
                <th>目标</th>
                <th>状态</th>
                <th>进度</th>
                <th>创建时间</th>
                <th className="actions-column">操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const checked = selectedIds.includes(task.id)
                return (
                  <tr key={task.id} className={checked ? 'row-selected' : undefined}>
                    <td className="checkbox-column">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSelect(task.id)}
                        aria-label={`选择 ${taskTypeLabel(task.type)} ${task.id.slice(0, 8)}`}
                      />
                    </td>
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
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {tasks.some((task) => task.status === 'failed' || task.status === 'canceled') ? (
        <div className="task-legend">
          <span>
            <XCircle size={14} />
            取消或失败的任务保留游标，可点击"继续"断点续传
          </span>
          <span>
            <CheckCircle2 size={14} />
            完成状态会持久化到本地 SQLite
          </span>
        </div>
      ) : null}

      {saveModalOpen ? (
        <SaveAsTemplateModal
          selectedTasks={selectedTasks}
          connections={connections}
          onClose={() => setSaveModalOpen(false)}
          onCreated={() => {
            setSelectedIds([])
            setSaveModalOpen(false)
            onNavigate('templates')
          }}
          onError={(message) => setError(message)}
        />
      ) : null}
    </div>
  )
}

interface SaveAsTemplateModalProps {
  selectedTasks: MigrationTask[]
  connections: ConnectionConfig[]
  onClose: () => void
  onCreated: () => void
  onError: (message: string) => void
}

function SaveAsTemplateModal({
  selectedTasks,
  connections,
  onClose,
  onCreated,
  onError
}: SaveAsTemplateModalProps): ReactElement {
  const defaultName = useMemo(() => {
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `任务组合-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  }, [])

  const [name, setName] = useState(defaultName)
  const [description, setDescription] = useState('')
  const [dataDir, setDataDir] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // Preview lines: engine/action + connection + target detail. Mirrors the
  // mapping the converter will apply, so the user can sanity-check before
  // committing.
  const previewLines = useMemo(
    () =>
      selectedTasks.map((task, index) => {
        const connectionName =
          connections.find((c) => c.id === task.connectionId)?.name ??
          `(已删除连接 ${task.connectionId.slice(0, 8)})`
        return {
          id: task.id,
          label: `${taskTypeLabel(task.type)} · ${connectionName} · ${taskTarget(task.payload)}`,
          index
        }
      }),
    [selectedTasks, connections]
  )

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setFormError(null)
    if (name.trim().length === 0) {
      setFormError('请输入模板名称')
      return
    }
    setSaving(true)
    try {
      const { input } = tasksToTemplateDraft({
        tasks: selectedTasks,
        connectionResolver: (id) =>
          connections.find((c) => c.id === id)?.name,
        name,
        description: description.trim() || undefined,
        dataDirDefault: dataDir
      })
      await window.api.templates.create(input)
      onCreated()
    } catch (cause) {
      if (cause instanceof TasksToTemplateDraftError) {
        setFormError(cause.message)
      } else {
        setFormError(errorMessage(cause))
        onError(errorMessage(cause))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-panel modal-panel-wide">
        <div className="modal-header">
          <h2>保存为模板</h2>
          <button type="button" className="button button-ghost" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="form-body">
            {formError ? <div className="inline-error">{formError}</div> : null}

            <div className="form-row">
              <div className="form-field">
                <label htmlFor="tmpl-name">
                  模板名称 <span className="required-marker">*</span>
                </label>
                <input
                  id="tmpl-name"
                  type="text"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-field">
                <label htmlFor="tmpl-desc">描述（可选）</label>
                <input
                  id="tmpl-desc"
                  type="text"
                  className="input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="例如：每日订单导出 + 入库"
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-field">
                <label htmlFor="tmpl-data-dir">
                  数据目录默认值（可选）
                </label>
                <input
                  id="tmpl-data-dir"
                  type="text"
                  className="input"
                  value={dataDir}
                  onChange={(e) => setDataDir(e.target.value)}
                  placeholder="例如 /var/lib/data/pg-to-es"
                />
                <span className="field-hint">
                  所有导出 / 导入文件将统一存放在 <code>{`{{${DATA_DIR_VARIABLE}}}`}</code> 目录下；
                  此处填的是执行模板时的默认值，留空则在执行时手动填入。
                </span>
              </div>
            </div>

            <div className="form-section-title">
              <span>将生成 {selectedTasks.length} 个步骤（按勾选顺序）</span>
            </div>

            <ol className="save-template-preview">
              {previewLines.map((line) => (
                <li key={line.id}>
                  <span className="cell-muted">#{line.index + 1}</span>
                  <span>{line.label}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="modal-footer">
            <button type="button" className="button button-secondary" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="button button-primary" disabled={saving}>
              {saving ? <Loader2 className="spin" size={14} /> : <FilePlus size={14} />}
              创建模板
            </button>
          </div>
        </form>
      </div>
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

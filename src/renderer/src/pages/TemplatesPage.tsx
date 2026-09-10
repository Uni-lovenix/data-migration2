import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Copy,
  FileUp,
  GitBranch,
  Loader2,
  Play,
  Plus,
  Trash2,
  X
} from 'lucide-react'

import type {
  CreateTemplateInput,
  MigrationTemplate,
  UpdateTemplateInput
} from '../../../shared/types'

export function TemplatesPage(): ReactElement {
  const [templates, setTemplates] = useState<MigrationTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<MigrationTemplate | null>(null)
  const [executeVars, setExecuteVars] = useState<Record<string, string>>({})
  const [executeTemplate, setExecuteTemplate] = useState<MigrationTemplate | null>(null)
  const [executing, setExecuting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [batchExecuteTemplates, setBatchExecuteTemplates] = useState<MigrationTemplate[]>([])
  const [batchVars, setBatchVars] = useState<Record<string, Record<string, string>>>({})
  const [batchExecuting, setBatchExecuting] = useState(false)

  useEffect(() => {
    loadTemplates()
  }, [])

  function loadTemplates(): void {
    setLoading(true)
    setError(null)
    window.api.templates
      .list()
      .then(setTemplates)
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setLoading(false))
  }

  async function handleDelete(id: string): Promise<void> {
    if (!confirm('确定要删除该模板吗？')) return
    setError(null)
    try {
      await window.api.templates.delete(id)
      loadTemplates()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function handleExecute(tmpl: MigrationTemplate): Promise<void> {
    setExecuteTemplate(tmpl)
    setExecuteVars(
      Object.fromEntries((tmpl.variables ?? []).map((v) => [v.name, v.defaultValue ?? '']))
    )
  }

  async function handleExecuteConfirm(): Promise<void> {
    if (!executeTemplate) return
    setExecuting(true)
    setError(null)
    try {
      await window.api.templates.execute(executeTemplate.id, executeVars)
      setExecuteTemplate(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setExecuting(false)
    }
  }

  function toggleSelect(id: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll(): void {
    setSelectedIds((prev) =>
      prev.size === templates.length ? new Set() : new Set(templates.map((t) => t.id))
    )
  }

  function openBatchExecute(): void {
    const selected = templates.filter((t) => selectedIds.has(t.id))
    const vars: Record<string, Record<string, string>> = {}
    for (const tmpl of selected) {
      vars[tmpl.id] = Object.fromEntries(
        (tmpl.variables ?? []).map((v) => [v.name, v.defaultValue ?? ''])
      )
    }
    setBatchExecuteTemplates(selected)
    setBatchVars(vars)
  }

  function closeBatchExecute(): void {
    setBatchExecuteTemplates([])
    setBatchVars({})
  }

  async function handleBatchExecuteConfirm(): Promise<void> {
    if (batchExecuteTemplates.length === 0) return
    setBatchExecuting(true)
    setError(null)
    try {
      await window.api.templates.executeMany(
        batchExecuteTemplates.map((tmpl) => ({ id: tmpl.id, vars: batchVars[tmpl.id] ?? {} }))
      )
      setSelectedIds(new Set())
      closeBatchExecute()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBatchExecuting(false)
    }
  }

  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>迁移模板</h1>
          <p>保存常用迁移配置，一键批量发起任务</p>
        </div>
        <div className="page-heading-actions">
          {selectedIds.size > 0 ? (
            <button
              type="button"
              className="button button-primary"
              onClick={openBatchExecute}
            >
              <Play size={16} />
              批量执行 ({selectedIds.size})
            </button>
          ) : null}
          <button
            type="button"
            className="button button-primary"
            onClick={() => {
              setEditing(null)
              setShowForm(true)
            }}
          >
            <Plus size={16} />
            新建模板
          </button>
        </div>
      </div>

      {error ? <div className="inline-error">{error}</div> : null}

      {showForm ? (
        <TemplateForm
          template={editing}
          onSave={async (input) => {
            if (editing) {
              await window.api.templates.update(editing.id, input as UpdateTemplateInput)
            } else {
              await window.api.templates.create(input as CreateTemplateInput)
            }
            setShowForm(false)
            loadTemplates()
          }}
          onCancel={() => setShowForm(false)}
        />
      ) : null}

      {executeTemplate ? (
        <ExecuteModal
          template={executeTemplate}
          vars={executeVars}
          onChange={setExecuteVars}
          executing={executing}
          onConfirm={() => void handleExecuteConfirm()}
          onCancel={() => setExecuteTemplate(null)}
        />
      ) : null}

      {batchExecuteTemplates.length > 0 ? (
        <BatchExecuteModal
          templates={batchExecuteTemplates}
          vars={batchVars}
          onChange={setBatchVars}
          executing={batchExecuting}
          onConfirm={() => void handleBatchExecuteConfirm()}
          onCancel={closeBatchExecute}
        />
      ) : null}

      <div className="table-card">
        {loading ? (
          <div className="table-empty">
            <Loader2 className="spin" size={30} />
            <span>加载模板中…</span>
          </div>
        ) : templates.length === 0 ? (
          <div className="table-empty">
            <GitBranch size={30} />
            <span>还没有迁移模板</span>
            <span className="table-empty-hint">
              从迁移工作台完成一次迁移后会自动保存为模板
            </span>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th className="checkbox-column">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === templates.length && templates.length > 0}
                    onChange={toggleSelectAll}
                    aria-label="全选"
                  />
                </th>
                <th>模板名称</th>
                <th>引擎</th>
                <th>操作</th>
                <th>变量</th>
                <th>创建时间</th>
                <th className="actions-column">操作</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((tmpl) => (
                <tr key={tmpl.id}>
                  <td className="checkbox-column">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(tmpl.id)}
                      onChange={() => toggleSelect(tmpl.id)}
                      aria-label={`选择 ${tmpl.name}`}
                    />
                  </td>
                  <td>
                    <div className="cell-name">{tmpl.name}</div>
                    {tmpl.description ? (
                      <div className="cell-sub">{tmpl.description}</div>
                    ) : null}
                  </td>
                  <td>
                    <span className={`badge engine-badge engine-${tmpl.engine}`}>
                      {tmpl.engine === 'pgmigrator' ? 'PostgreSQL' : 'Elasticsearch'}
                    </span>
                  </td>
                  <td>
                    <span className="badge">
                      {tmpl.action === 'export' ? '导出' : '导入'}
                    </span>
                  </td>
                  <td>
                    {tmpl.variables.length > 0 ? (
                      <div className="cell-tags">
                        {tmpl.variables.map((v) => (
                          <span key={v.name} className="tag">
                            {`{{${v.name}}}`}
                            {v.defaultValue ? ` = ${v.defaultValue}` : ''}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="cell-muted">无</span>
                    )}
                  </td>
                  <td className="cell-muted">{formatDateTime(tmpl.createdAt)}</td>
                  <td className="actions-column">
                    <button
                      type="button"
                      className="button button-primary button-small"
                      onClick={() => void handleExecute(tmpl)}
                    >
                      <Play size={14} />
                      执行
                    </button>
                    <button
                      type="button"
                      className="button button-secondary button-small"
                      onClick={() => {
                        setEditing(tmpl)
                        setShowForm(true)
                      }}
                    >
                      <Copy size={14} />
                      编辑
                    </button>
                    <button
                      type="button"
                      className="button button-ghost button-small"
                      onClick={() => void handleDelete(tmpl.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

interface TemplateFormProps {
  template: MigrationTemplate | null
  onSave: (input: CreateTemplateInput) => Promise<void>
  onCancel: () => void
}

function TemplateForm({ template, onSave, onCancel }: TemplateFormProps): ReactElement {
  const [name, setName] = useState(template?.name ?? '')
  const [description, setDescription] = useState(template?.description ?? '')
  const [engine, setEngine] = useState<'esmigrator' | 'pgmigrator'>(
    template?.engine ?? 'esmigrator'
  )
  const [action, setAction] = useState<'export' | 'import'>(template?.action ?? 'export')
  const [connectionName, setConnectionName] = useState(template?.connectionName ?? '')
  const [dstConnectionName, setDstConnectionName] = useState(template?.dstConnectionName ?? '')
  const [configJson, setConfigJson] = useState(template?.configJson ?? '{\n  \n}')
  const [varsText, setVarsText] = useState(
    (template?.variables ?? [])
      .map((v) => `${v.name}|${v.defaultValue ?? ''}|${v.description ?? ''}`)
      .join('\n')
  )
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setFormError(null)
    setSaving(true)
    try {
      const variables = varsText
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const parts = line.split('|')
          return {
            name: parts[0]?.trim() ?? '',
            defaultValue: parts[1]?.trim() || undefined,
            description: parts[2]?.trim() || undefined
          }
        })
        .filter((v) => v.name.length > 0)

      await onSave({
        name,
        description: description || undefined,
        engine,
        action,
        connectionName,
        dstConnectionName: dstConnectionName || undefined,
        configJson,
        variables: variables.length > 0 ? variables : []
      })
    } catch (cause) {
      setFormError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal-panel">
        <div className="modal-header">
          <h2>{template ? '编辑模板' : '新建模板'}</h2>
          <button type="button" className="button button-ghost" onClick={onCancel}>
            <X size={18} />
          </button>
        </div>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="form-body">
            {formError ? <div className="inline-error">{formError}</div> : null}

            <div className="form-row">
              <div className="form-field">
                <label htmlFor="tmpl-name">模板名称</label>
                <input
                  id="tmpl-name"
                  type="text"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：每日ES索引备份"
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
                  placeholder="模板用途说明"
                />
              </div>
            </div>

            <div className="form-row form-row-split">
              <div className="form-field">
                <label htmlFor="tmpl-engine">引擎</label>
                <select
                  id="tmpl-engine"
                  className="input"
                  value={engine}
                  onChange={(e) =>
                    setEngine(e.target.value as 'esmigrator' | 'pgmigrator')
                  }
                >
                  <option value="pgmigrator">PostgreSQL</option>
                  <option value="esmigrator">Elasticsearch</option>
                </select>
              </div>
              <div className="form-field">
                <label htmlFor="tmpl-action">操作</label>
                <select
                  id="tmpl-action"
                  className="input"
                  value={action}
                  onChange={(e) => setAction(e.target.value as 'export' | 'import')}
                >
                  <option value="export">导出</option>
                  <option value="import">导入</option>
                </select>
              </div>
            </div>

            <div className="form-row form-row-split">
              <div className="form-field">
                <label htmlFor="tmpl-src-conn">源连接名称</label>
                <input
                  id="tmpl-src-conn"
                  type="text"
                  className="input"
                  value={connectionName}
                  onChange={(e) => setConnectionName(e.target.value)}
                  placeholder="源连接名称"
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="tmpl-dst-conn">目标连接名称</label>
                <input
                  id="tmpl-dst-conn"
                  type="text"
                  className="input"
                  value={dstConnectionName}
                  onChange={(e) => setDstConnectionName(e.target.value)}
                  placeholder="目标连接名称（可选）"
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-field">
                <label htmlFor="tmpl-config">配置 JSON</label>
                <textarea
                  id="tmpl-config"
                  className="input textarea-code"
                  value={configJson}
                  onChange={(e) => setConfigJson(e.target.value)}
                  rows={6}
                  placeholder={'{\n  "table": { "schema": "public", "name": "users" },\n  "outputFile": "/path/to/export.jsonl"\n}'}
                  required
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-field">
                <label htmlFor="tmpl-vars">
                  变量（可选）
                  <span className="field-hint">每行格式：name|默认值|说明</span>
                </label>
                <textarea
                  id="tmpl-vars"
                  className="input textarea-code"
                  value={varsText}
                  onChange={(e) => setVarsText(e.target.value)}
                  rows={4}
                  placeholder={'DATE|2026-01-01|导出日期\nTABLE|users|表名'}
                />
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="button button-secondary" onClick={onCancel}>
              取消
            </button>
            <button type="submit" className="button button-primary" disabled={saving}>
              {saving ? <Loader2 className="spin" size={14} /> : <FileUp size={14} />}
              {template ? '保存修改' : '创建模板'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

interface ExecuteModalProps {
  template: MigrationTemplate
  vars: Record<string, string>
  onChange: (vars: Record<string, string>) => void
  executing: boolean
  onConfirm: () => void
  onCancel: () => void
}

function ExecuteModal({
  template,
  vars,
  onChange,
  executing,
  onConfirm,
  onCancel
}: ExecuteModalProps): ReactElement {
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal-panel">
        <div className="modal-header">
          <h2>执行模板</h2>
          <button type="button" className="button button-ghost" onClick={onCancel}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          <p className="execute-summary">
            即将执行模板 <strong>{template.name}</strong>（{template.engine} {template.action}）
          </p>

          {template.variables.length > 0 ? (
            <div className="form-row">
              <div className="form-field">
                <label>变量填充</label>
                {template.variables.map((v) => (
                  <div key={v.name} className="var-row">
                    <label htmlFor={`var-${v.name}`} className="var-label">
                      {`{{${v.name}}}`}
                      {v.description ? <span className="var-desc"> — {v.description}</span> : null}
                    </label>
                    <input
                      id={`var-${v.name}`}
                      type="text"
                      className="input"
                      value={vars[v.name] ?? ''}
                      onChange={(e) => onChange({ ...vars, [v.name]: e.target.value })}
                      placeholder={v.defaultValue ?? ''}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="cell-muted">此模板无变量，直接执行。</p>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="button button-secondary" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={executing}
            onClick={onConfirm}
          >
            {executing ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
            发起迁移任务
          </button>
        </div>
      </div>
    </div>
  )
}

interface BatchExecuteModalProps {
  templates: MigrationTemplate[]
  vars: Record<string, Record<string, string>>
  onChange: (vars: Record<string, Record<string, string>>) => void
  executing: boolean
  onConfirm: () => void
  onCancel: () => void
}

function BatchExecuteModal({
  templates,
  vars,
  onChange,
  executing,
  onConfirm,
  onCancel
}: BatchExecuteModalProps): ReactElement {
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal-panel modal-panel-wide">
        <div className="modal-header">
          <h2>批量执行模板</h2>
          <button type="button" className="button button-ghost" onClick={onCancel}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          <p className="execute-summary">
            即将并行执行 <strong>{templates.length}</strong> 个模板
          </p>
          <div className="batch-templates-list">
            {templates.map((tmpl) => (
              <div key={tmpl.id} className="batch-template-item">
                <div className="batch-template-header">
                  <strong>{tmpl.name}</strong>
                  <span className="badge engine-badge engine-{tmpl.engine}">
                    {tmpl.engine === 'pgmigrator' ? 'PG' : 'ES'} · {tmpl.action}
                  </span>
                </div>
                {tmpl.variables.length > 0 ? (
                  <div className="batch-var-group">
                    {tmpl.variables.map((v) => (
                      <div key={v.name} className="batch-var-row">
                        <label htmlFor={`batch-${tmpl.id}-${v.name}`} className="var-label">
                          {`{{${v.name}}}`}
                          {v.description ? <span className="var-desc"> — {v.description}</span> : null}
                        </label>
                        <input
                          id={`batch-${tmpl.id}-${v.name}`}
                          type="text"
                          className="input"
                          value={vars[tmpl.id]?.[v.name] ?? ''}
                          onChange={(e) =>
                            onChange({
                              ...vars,
                              [tmpl.id]: {
                                ...vars[tmpl.id],
                                [v.name]: e.target.value
                              }
                            })
                          }
                          placeholder={v.defaultValue ?? ''}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="cell-muted cell-small">无变量</p>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="button button-secondary" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={executing}
            onClick={onConfirm}
          >
            {executing ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
            发起 {templates.length} 个迁移任务
          </button>
        </div>
      </div>
    </div>
  )
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
  return error instanceof Error ? error.message : '操作失败'
}

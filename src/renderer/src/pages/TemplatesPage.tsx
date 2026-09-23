import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Copy,
  FileUp,
  GitBranch,
  Loader2,
  Play,
  Plus,
  Trash2,
  Wand2,
  X
} from 'lucide-react'

import type {
  ConnectionConfig,
  CreateTemplateInput,
  MigrationTemplate,
  TemplateStep,
  TemplateVariable,
  UpdateTemplateInput
} from '../../../shared/types'
import {
  ACTION_LABELS,
  ENGINE_LABELS,
  engineToConnectionType,
  exampleConfigJson,
  TEMPLATE_ENGINE_ACTIONS
} from '../../../shared/template-examples'
import { TEMPLATE_ENGINES } from '../../../shared/types'

interface TemplatesPageProps {
  connections: ConnectionConfig[]
  onNavigate: (view: 'tasks') => void
}

export function TemplatesPage({
  connections,
  onNavigate
}: TemplatesPageProps): ReactElement {
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
    // Merge template-level vars + vars from each step so the execute modal
    // surfaces every placeholder that may need a value at runtime.
    const allVars: Record<string, string> = {}
    for (const v of tmpl.variables) allVars[v.name] = v.defaultValue ?? ''
    const sources = tmpl.steps.length > 0 ? tmpl.steps : [topLevelAsStep(tmpl)]
    for (const step of sources) {
      for (const v of step.variables ?? []) {
        if (!(v.name in allVars)) allVars[v.name] = v.defaultValue ?? ''
      }
    }
    setExecuteVars(allVars)
    setExecuteTemplate(tmpl)
  }

  async function handleExecuteConfirm(): Promise<void> {
    if (!executeTemplate) return
    setExecuting(true)
    setError(null)
    try {
      await window.api.templates.execute(executeTemplate.id, executeVars)
      setExecuteTemplate(null)
      onNavigate('tasks')
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
      const seeded: Record<string, string> = {}
      for (const v of tmpl.variables) seeded[v.name] = v.defaultValue ?? ''
      const sources = tmpl.steps.length > 0 ? tmpl.steps : [topLevelAsStep(tmpl)]
      for (const step of sources) {
        for (const v of step.variables ?? []) {
          if (!(v.name in seeded)) seeded[v.name] = v.defaultValue ?? ''
        }
      }
      vars[tmpl.id] = seeded
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
      onNavigate('tasks')
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
          connections={connections}
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
              点击右上角「新建模板」开始配置。支持单个任务或编排多个步骤串行执行。
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
                <th>步骤</th>
                <th>变量</th>
                <th>创建时间</th>
                <th className="actions-column">操作</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((tmpl) => {
                const totalVars = countAllVars(tmpl)
                const stepCount = tmpl.steps.length > 0 ? tmpl.steps.length : 1
                return (
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
                        {ENGINE_LABELS[tmpl.engine]}
                      </span>
                    </td>
                    <td>
                      <span className="badge">
                        {ACTION_LABELS[tmpl.action]}
                      </span>
                    </td>
                    <td>
                      <span className="cell-muted">
                        {stepCount > 1 ? `${stepCount} 个步骤` : '单任务'}
                      </span>
                    </td>
                    <td>
                      {totalVars > 0 ? (
                        <div className="cell-tags">
                          {collectAllVars(tmpl).map((v) => (
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
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

interface TemplateFormProps {
  template: MigrationTemplate | null
  connections: ConnectionConfig[]
  onSave: (input: CreateTemplateInput) => Promise<void>
  onCancel: () => void
}

function TemplateForm({
  template,
  connections,
  onSave,
  onCancel
}: TemplateFormProps): ReactElement {
  const initialSteps = useMemo<TemplateStep[]>(() => {
    if (template?.steps && template.steps.length > 0) return template.steps
    if (template) return [topLevelAsStep(template)]
    return [createEmptyStep()]
  }, [template])

  const [name, setName] = useState(template?.name ?? '')
  const [description, setDescription] = useState(template?.description ?? '')
  const [steps, setSteps] = useState<TemplateStep[]>(initialSteps)
  const [stepJsonErrors, setStepJsonErrors] = useState<Record<string, string | null>>({})
  const [varsText, setVarsText] = useState(serializeVars(template?.variables ?? []))
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  function updateStep(id: string, patch: Partial<TemplateStep>): void {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  function handleEngineActionChange(
    id: string,
    engine: TemplateStep['engine'],
    action: TemplateStep['action']
  ): void {
    const current = steps.find((s) => s.id === id)
    if (!current) return
    const nextAction = TEMPLATE_ENGINE_ACTIONS[engine].includes(action)
      ? action
      : TEMPLATE_ENGINE_ACTIONS[engine][0]!
    const sameEngine = current.engine === engine
    const sameAction = current.action === nextAction
    const example = exampleConfigJson(engine, nextAction)
    // Auto-fill the config JSON with an example when it's empty or still the
    // previous example — avoids stomping user edits.
    const shouldReplace =
      current.configJson.trim() === '' ||
      current.configJson === exampleConfigJson(current.engine, current.action)
    updateStep(id, {
      engine,
      action: nextAction,
      ...(shouldReplace ? { configJson: sameEngine && sameAction ? current.configJson : example } : {})
    })
  }

  function handleInsertExample(id: string): void {
    const current = steps.find((s) => s.id === id)
    if (!current) return
    updateStep(id, { configJson: exampleConfigJson(current.engine, current.action) })
  }

  function handleConfigJsonChange(id: string, value: string): void {
    updateStep(id, { configJson: value })
    if (value.trim() === '') {
      setStepJsonErrors((prev) => ({ ...prev, [id]: null }))
      return
    }
    try {
      JSON.parse(value)
      setStepJsonErrors((prev) => ({ ...prev, [id]: null }))
    } catch (cause) {
      setStepJsonErrors((prev) => ({
        ...prev,
        [id]: cause instanceof Error ? cause.message : 'JSON 解析失败'
      }))
    }
  }

  function addStep(): void {
    const last = steps[steps.length - 1]
    const engine: TemplateStep['engine'] = last?.engine ?? 'pgmigrator'
    const action: TemplateStep['action'] = last?.action ?? 'export'
    setSteps((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        engine,
        action,
        connectionName: '',
        configJson: exampleConfigJson(engine, action),
        variables: []
      }
    ])
  }

  function removeStep(id: string): void {
    setSteps((prev) => (prev.length <= 1 ? prev : prev.filter((s) => s.id !== id)))
    setStepJsonErrors((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  function moveStep(id: string, direction: -1 | 1): void {
    setSteps((prev) => {
      const index = prev.findIndex((s) => s.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= prev.length) return prev
      const next = prev.slice()
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item!)
      return next
    })
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setFormError(null)

    if (name.trim().length === 0) {
      setFormError('请输入模板名称')
      return
    }

    // Validate each step's JSON.
    for (const step of steps) {
      try {
        JSON.parse(step.configJson)
      } catch (cause) {
        setFormError(`步骤「${step.name || step.id.slice(0, 6)}」配置 JSON 解析失败：${
          cause instanceof Error ? cause.message : '格式错误'
        }`)
        return
      }
    }

    const templateVars = parseVarsText(varsText)
    const cleanedSteps: TemplateStep[] = steps.map((s) => ({
      id: s.id,
      name: s.name?.trim() || undefined,
      engine: s.engine,
      action: s.action,
      connectionName: s.connectionName.trim(),
      dstConnectionName: s.dstConnectionName?.trim() || undefined,
      configJson: s.configJson,
      // Step-level vars live on the parent as a parsed TemplateVariable[];
      // re-serializing + re-parsing here would silently drop fields the user
      // is still typing (trailing empty segments, in-progress lines).
      variables: s.variables ?? []
    }))

    const first = cleanedSteps[0]!
    setSaving(true)
    try {
      await onSave({
        name: name.trim(),
        description: description.trim() || undefined,
        // Mirror step[0] into the legacy top-level fields for backwards compat
        // with single-task fallback paths.
        engine: first.engine,
        action: first.action,
        connectionName: first.connectionName,
        dstConnectionName: first.dstConnectionName,
        configJson: first.configJson,
        variables: templateVars,
        steps: cleanedSteps
      })
    } catch (cause) {
      setFormError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal-panel modal-panel-wide">
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
                <label htmlFor="tmpl-name">
                  模板名称 <span className="required-marker">*</span>
                </label>
                <input
                  id="tmpl-name"
                  type="text"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：每日订单导出-PG"
                  required
                />
                <span className="field-hint">
                  建议带上场景，便于在列表里快速识别。
                </span>
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

            <div className="form-section-title">
              <span>步骤列表</span>
              <span className="field-hint">
                步骤按顺序串行执行。多步骤场景：先导出再导入、跨表批量、跨源端链路等。
              </span>
            </div>

            <div className="step-list">
              {steps.map((step, index) => (
                <StepCard
                  key={step.id}
                  step={step}
                  index={index}
                  total={steps.length}
                  connections={connections}
                  jsonError={stepJsonErrors[step.id] ?? null}
                  onEngineActionChange={(engine, action) =>
                    handleEngineActionChange(step.id, engine, action)
                  }
                  onPatch={(patch) => updateStep(step.id, patch)}
                  onConfigJsonChange={(value) => handleConfigJsonChange(step.id, value)}
                  onInsertExample={() => handleInsertExample(step.id)}
                  onRemove={() => removeStep(step.id)}
                  onMoveUp={() => moveStep(step.id, -1)}
                  onMoveDown={() => moveStep(step.id, 1)}
                />
              ))}
            </div>

            <button type="button" className="button button-secondary step-add" onClick={addStep}>
              <Plus size={14} />
              添加步骤
            </button>

            <details className="form-cheatsheet">
              <summary>字段速查（点击展开）</summary>
              <div className="cheatsheet-grid">
                <div>
                  <strong>type</strong>
                  <code>postgres-export</code> / <code>postgres-export-batch</code> /
                  <code>postgres-import</code> / <code>elasticsearch-export</code> /
                  <code>elasticsearch-import</code>
                </div>
                <div>
                  <strong>table</strong>
                  <code>{`{ "schema": "public", "name": "users" }`}</code>
                </div>
                <div>
                  <strong>outputFile / inputFile</strong> 导出/导入文件路径，支持 <code>{`{{TODAY}}`}</code> 占位符。
                </div>
                <div>
                  <strong>batchSize</strong> 1–10000，默认 5000。
                </div>
                <div>
                  <strong>onConflict</strong> 导入时冲突处理：<code>skip</code> / <code>overwrite</code> / <code>error</code>。
                </div>
                <div>
                  <strong>strategy</strong> 导出策略：<code>scroll</code>（默认）/ <code>search_after</code>。
                </div>
              </div>
            </details>

            <div className="form-row">
              <div className="form-field">
                <label htmlFor="tmpl-vars">
                  模板级变量（可选）
                  <span className="field-hint">每行格式：name|默认值|说明，会应用到所有步骤</span>
                </label>
                <textarea
                  id="tmpl-vars"
                  className="input textarea-code"
                  value={varsText}
                  onChange={(e) => setVarsText(e.target.value)}
                  rows={3}
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

interface StepCardProps {
  step: TemplateStep
  index: number
  total: number
  connections: ConnectionConfig[]
  jsonError: string | null
  onEngineActionChange: (engine: TemplateStep['engine'], action: TemplateStep['action']) => void
  onPatch: (patch: Partial<TemplateStep>) => void
  onConfigJsonChange: (value: string) => void
  onInsertExample: () => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}

function StepCard({
  step,
  index,
  total,
  connections,
  jsonError,
  onEngineActionChange,
  onPatch,
  onConfigJsonChange,
  onInsertExample,
  onRemove,
  onMoveUp,
  onMoveDown
}: StepCardProps): ReactElement {
  const allowedType = engineToConnectionType(step.engine)
  const compatibleConnections = connections.filter((c) => c.type === allowedType)
  // Hold the vars textarea as a local string so each keystroke is rendered
  // verbatim. Routing through `serializeVars(step.variables)` on every render
  // would lose trailing `|` segments, drop in-progress empty lines, and strip
  // spaces (parseVarsText trims each line), making the field genuinely
  // un-editable. The string stays the source of truth; on submit the parent
  // parses it back into `step.variables`.
  const [varsDraft, setVarsDraft] = useState(() => serializeVars(step.variables ?? []))
  // Re-seed when the underlying step changes (e.g. user picks a different
  // step from a re-used card). Most edits stay on a stable step id and never
  // hit this branch.
  const lastVarsStepId = useRef(step.id)
  if (lastVarsStepId.current !== step.id) {
    lastVarsStepId.current = step.id
    setVarsDraft(serializeVars(step.variables ?? []))
  }

  return (
    <div className="step-card">
      <div className="step-card-header">
        <span className="step-card-title">
          步骤 {index + 1}
          {step.name ? ` · ${step.name}` : ''}
        </span>
        <div className="step-card-actions">
          <button
            type="button"
            className="button button-ghost button-small"
            disabled={index === 0}
            onClick={onMoveUp}
            aria-label="上移"
            title="上移"
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className="button button-ghost button-small"
            disabled={index === total - 1}
            onClick={onMoveDown}
            aria-label="下移"
            title="下移"
          >
            <ArrowDown size={14} />
          </button>
          <button
            type="button"
            className="button button-ghost button-small"
            disabled={total <= 1}
            onClick={onRemove}
            aria-label="删除"
            title={total <= 1 ? '至少保留 1 个步骤' : '删除步骤'}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="step-card-body">
        <div className="form-row">
          <div className="form-field">
            <label htmlFor={`step-name-${step.id}`}>步骤名称（可选）</label>
            <input
              id={`step-name-${step.id}`}
              type="text"
              className="input"
              value={step.name ?? ''}
              onChange={(e) => onPatch({ name: e.target.value })}
              placeholder={`步骤 ${index + 1}`}
            />
          </div>
        </div>

        <div className="form-row form-row-split">
          <div className="form-field">
            <label htmlFor={`step-engine-${step.id}`}>引擎</label>
            <select
              id={`step-engine-${step.id}`}
              className="input"
              value={step.engine}
              onChange={(e) =>
                onEngineActionChange(
                  e.target.value as TemplateStep['engine'],
                  step.action
                )
              }
            >
              {TEMPLATE_ENGINES.map((engine) => (
                <option key={engine} value={engine}>
                  {ENGINE_LABELS[engine]}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor={`step-action-${step.id}`}>操作</label>
            <select
              id={`step-action-${step.id}`}
              className="input"
              value={step.action}
              onChange={(e) =>
                onEngineActionChange(
                  step.engine,
                  e.target.value as TemplateStep['action']
                )
              }
            >
              {TEMPLATE_ENGINE_ACTIONS[step.engine].map((action) => (
                <option key={action} value={action}>
                  {ACTION_LABELS[action]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="form-row form-row-split">
          <div className="form-field">
            <label htmlFor={`step-src-${step.id}`}>
              {step.action === 'import' ? '目标连接' : '源连接'}{' '}
              <span className="required-marker">*</span>
            </label>
            <select
              id={`step-src-${step.id}`}
              className="input"
              value={step.connectionName}
              onChange={(e) => onPatch({ connectionName: e.target.value })}
              required
            >
              <option value="">— 选择 {ENGINE_LABELS[step.engine]} 连接 —</option>
              {compatibleConnections.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            {compatibleConnections.length === 0 ? (
              <span className="field-hint field-hint-warning">
                当前没有 {ENGINE_LABELS[step.engine]} 连接，请先到「连接」页面创建。
              </span>
            ) : null}
          </div>
          <div className="form-field">
            <label htmlFor={`step-dst-${step.id}`}>目标连接（可选）</label>
            <select
              id={`step-dst-${step.id}`}
              className="input"
              value={step.dstConnectionName ?? ''}
              onChange={(e) =>
                onPatch({ dstConnectionName: e.target.value || undefined })
              }
            >
              <option value="">— 无 —</option>
              {compatibleConnections.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <span className="field-hint">导入时使用；导出留空。</span>
          </div>
        </div>

        <div className="form-row">
          <div className="form-field">
            <div className="form-field-label-row">
              <label htmlFor={`step-config-${step.id}`}>
                配置 JSON <span className="required-marker">*</span>
              </label>
              <button
                type="button"
                className="button button-ghost button-small"
                onClick={onInsertExample}
                title="用当前引擎/操作的示例配置替换"
              >
                <Wand2 size={14} />
                插入示例
              </button>
            </div>
            <textarea
              id={`step-config-${step.id}`}
              className={`input textarea-code${jsonError ? ' input-invalid' : ''}`}
              value={step.configJson}
              onChange={(e) => onConfigJsonChange(e.target.value)}
              rows={7}
              spellCheck={false}
              required
            />
            {jsonError ? (
              <span className="field-hint field-hint-error">JSON 解析失败：{jsonError}</span>
            ) : (
              <span className="field-hint">
                支持 <code>{`{{VAR}}`}</code> 占位符；可用变量名见下方「模板级变量」和「步骤级变量」。
              </span>
            )}
          </div>
        </div>

        <div className="form-row">
          <div className="form-field">
            <label htmlFor={`step-vars-${step.id}`}>
              步骤级变量（可选）
              <span className="field-hint">每行格式：name|默认值|说明，仅作用于本步骤</span>
            </label>
            <textarea
              id={`step-vars-${step.id}`}
              className="input textarea-code"
              value={varsDraft}
              onChange={(e) => {
                const next = e.target.value
                setVarsDraft(next)
                onPatch({ variables: parseVarsText(next) })
              }}
              rows={2}
              placeholder={'TABLE|orders|本步导出的表名'}
            />
          </div>
        </div>
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
  const allVars = collectAllVars(template)
  const stepCount = template.steps.length > 0 ? template.steps.length : 1

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
            即将执行模板 <strong>{template.name}</strong>
            （{ENGINE_LABELS[template.engine]} {ACTION_LABELS[template.action]}，
            共 {stepCount} 个任务，将按顺序串行执行）
          </p>

          {allVars.length > 0 ? (
            <div className="form-row">
              <div className="form-field">
                <label>变量填充</label>
                {allVars.map((v) => (
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
            {stepCount > 1 ? `发起 ${stepCount} 个迁移任务` : '发起迁移任务'}
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
                  <span className={`badge engine-badge engine-${tmpl.engine}`}>
                    {ENGINE_LABELS[tmpl.engine]} · {ACTION_LABELS[tmpl.action]}
                    {tmpl.steps.length > 1 ? ` · ${tmpl.steps.length} 步` : ''}
                  </span>
                </div>
                {collectAllVars(tmpl).length > 0 ? (
                  <div className="batch-var-group">
                    {collectAllVars(tmpl).map((v) => (
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

// ---- helpers ----

function createEmptyStep(): TemplateStep {
  return {
    id: crypto.randomUUID(),
    engine: 'pgmigrator',
    action: 'export',
    connectionName: '',
    configJson: exampleConfigJson('pgmigrator', 'export'),
    variables: []
  }
}

function topLevelAsStep(tmpl: MigrationTemplate): TemplateStep {
  return {
    id: 'legacy',
    engine: tmpl.engine,
    action: tmpl.action,
    connectionName: tmpl.connectionName,
    dstConnectionName: tmpl.dstConnectionName,
    configJson: tmpl.configJson,
    variables: tmpl.variables
  }
}

function serializeVars(vars: TemplateVariable[]): string {
  return vars
    .map((v) => `${v.name}|${v.defaultValue ?? ''}|${v.description ?? ''}`)
    .join('\n')
}

function parseVarsText(text: string): TemplateVariable[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split('|')
      return {
        name: parts[0]?.trim() ?? '',
        defaultValue: parts[1]?.trim() || undefined,
        description: parts[2]?.trim() || undefined
      }
    })
    .filter((v) => v.name.length > 0)
}

function collectAllVars(tmpl: MigrationTemplate): TemplateVariable[] {
  const seen = new Set<string>()
  const out: TemplateVariable[] = []
  const push = (v: TemplateVariable): void => {
    if (seen.has(v.name)) return
    seen.add(v.name)
    out.push(v)
  }
  for (const v of tmpl.variables) push(v)
  const sources = tmpl.steps.length > 0 ? tmpl.steps : [topLevelAsStep(tmpl)]
  for (const step of sources) {
    for (const v of step.variables ?? []) push(v)
  }
  return out
}

function countAllVars(tmpl: MigrationTemplate): number {
  return collectAllVars(tmpl).length
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

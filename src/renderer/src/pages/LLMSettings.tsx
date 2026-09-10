import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { Brain, Pencil, Plus, Search, Trash2, ToggleLeft, ToggleRight } from 'lucide-react'

import type {
  LLMConfig,
  LLMConfigInput,
  LLMProvider,
  UpdateLLMConfigInput
} from '../../../shared/types'
import { LLMProviderLabels } from '../components/LLMProviderLabels'
import { IconButton } from '../components/IconButton'

interface LLMSettingsProps {
  configs: LLMConfig[]
  isLoading: boolean
  error: string | null
  onCreate: (input: LLMConfigInput) => Promise<LLMConfig>
  onUpdate: (id: string, input: UpdateLLMConfigInput) => Promise<LLMConfig>
  onDelete: (id: string) => Promise<void>
  onToggle: (id: string) => Promise<LLMConfig>
}

interface ModalState {
  mode: 'create' | 'edit'
  config?: LLMConfig
}

export function LLMSettings({
  configs,
  isLoading,
  error,
  onCreate,
  onUpdate,
  onDelete,
  onToggle
}: LLMSettingsProps): ReactElement {
  const [filter, setFilter] = useState<LLMProvider | 'all'>('all')
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState<ModalState | null>(null)

  const filteredConfigs = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return configs.filter((config) => {
      if (filter !== 'all' && config.provider !== filter) {
        return false
      }
      if (keyword.length === 0) {
        return true
      }
      return (
        config.name.toLowerCase().includes(keyword) ||
        config.model.toLowerCase().includes(keyword) ||
        config.provider.toLowerCase().includes(keyword)
      )
    })
  }, [configs, filter, search])

  async function handleDelete(config: LLMConfig): Promise<void> {
    const confirmed = window.confirm(`删除 LLM 配置「${config.name}」？`)
    if (!confirmed) {
      return
    }
    try {
      await onDelete(config.id)
    } catch {
      // Error surfaced by the shared LLM store when invoked.
    }
  }

  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>LLM 配置</h1>
          <p>管理 Ollama、Anthropic、OpenAI 连接</p>
        </div>
        <button
          type="button"
          className="button button-primary"
          onClick={() => setModal({ mode: 'create' })}
        >
          <Plus size={16} />
          新建配置
        </button>
      </div>

      <div className="toolbar">
        <div className="segmented">
          <button
            type="button"
            className={filter === 'all' ? 'segment segment-active' : 'segment'}
            onClick={() => setFilter('all')}
          >
            全部
          </button>
          <button
            type="button"
            className={filter === 'ollama' ? 'segment segment-active' : 'segment'}
            onClick={() => setFilter('ollama')}
          >
            Ollama
          </button>
          <button
            type="button"
            className={filter === 'anthropic' ? 'segment segment-active' : 'segment'}
            onClick={() => setFilter('anthropic')}
          >
            Anthropic
          </button>
          <button
            type="button"
            className={filter === 'openai' ? 'segment segment-active' : 'segment'}
            onClick={() => setFilter('openai')}
          >
            OpenAI
          </button>
        </div>

        <div className="search-box">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索名称、模型或类型"
            aria-label="搜索 LLM 配置"
          />
        </div>
      </div>

      {error ? <div className="inline-error">{error}</div> : null}

      <div className="table-card">
        {isLoading ? (
          <div className="table-empty">加载中…</div>
        ) : filteredConfigs.length === 0 ? (
          <div className="table-empty">
            <Brain size={30} />
            <span>没有匹配的 LLM 配置</span>
            <button
              type="button"
              className="button button-primary"
              onClick={() => setModal({ mode: 'create' })}
            >
              <Plus size={15} />
              新建配置
            </button>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>模型</th>
                <th>API 地址</th>
                <th>启用</th>
                <th>更新时间</th>
                <th className="actions-column">操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredConfigs.map((config) => (
                <tr key={config.id}>
                  <td>
                    <div className="cell-name">{config.name}</div>
                    {config.apiKey ? (
                      <div className="cell-sub">••••••••</div>
                    ) : null}
                  </td>
                  <td>
                    <span className="badge">{LLMProviderLabels[config.provider]}</span>
                  </td>
                  <td>
                    <code>{config.model}</code>
                  </td>
                  <td className="cell-muted">
                    {config.apiBase ?? '默认'}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="toggle-btn"
                      onClick={() => void onToggle(config.id)}
                      aria-label={config.enabled ? '禁用' : '启用'}
                    >
                      {config.enabled ? (
                        <ToggleRight size={20} className="toggle-on" />
                      ) : (
                        <ToggleLeft size={20} className="toggle-off" />
                      )}
                    </button>
                  </td>
                  <td className="cell-muted">
                    {formatDateTime(config.updatedAt)}
                  </td>
                  <td className="actions-column">
                    <IconButton
                      icon={Pencil}
                      label="编辑"
                      onClick={() => setModal({ mode: 'edit', config })}
                    />
                    <IconButton
                      icon={Trash2}
                      label="删除"
                      variant="danger"
                      onClick={() => void handleDelete(config)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modal ? (
        <LLMConfigModal
          mode={modal.mode}
          config={modal.config}
          onClose={() => setModal(null)}
          onSave={async (input) => {
            if (modal.mode === 'create') {
              await onCreate(input)
            } else if (modal.config) {
              await onUpdate(modal.config.id, input)
            }
          }}
        />
      ) : null}
    </div>
  )
}

interface LLMConfigModalProps {
  mode: 'create' | 'edit'
  config?: LLMConfig
  onClose: () => void
  onSave: (input: LLMConfigInput) => Promise<void>
}

function LLMConfigModal({ mode, config, onClose, onSave }: LLMConfigModalProps): ReactElement {
  const [name, setName] = useState(config?.name ?? '')
  const [provider, setProvider] = useState<LLMProvider>(config?.provider ?? 'ollama')
  const [apiBase, setApiBase] = useState(config?.apiBase ?? '')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(config?.model ?? '')
  const [enabled, setEnabled] = useState(config?.enabled ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const input: LLMConfigInput = {
        name: name.trim(),
        provider,
        apiBase: apiBase.trim() || undefined,
        apiKey: apiKey || undefined,
        model: model.trim(),
        enabled
      }
      await onSave(input)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <h2>{mode === 'create' ? '新建 LLM 配置' : '编辑 LLM 配置'}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="modal-body">
            {error ? <div className="inline-error">{error}</div> : null}

            <div className="form-group">
              <label htmlFor="llm-name">名称</label>
              <input
                id="llm-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="我的 Ollama"
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="llm-provider">提供商</label>
              <select
                id="llm-provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value as LLMProvider)}
              >
                <option value="ollama">Ollama（本地）</option>
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="llm-model">模型</label>
              <input
                id="llm-model"
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={provider === 'ollama' ? 'llama3.2' : 'claude-3-5-sonnet-20241022 / gpt-4o'}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="llm-api-base">
                API 地址
                <span className="form-hint">
                  {provider === 'ollama' ? '（默认 http://localhost:11434）' : '（可选）'}
                </span>
              </label>
              <input
                id="llm-api-base"
                type="url"
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
                placeholder={provider === 'ollama' ? 'http://localhost:11434' : 'https://api.anthropic.com'}
              />
            </div>

            {(provider === 'anthropic' || provider === 'openai') && (
              <div className="form-group">
                <label htmlFor="llm-api-key">API Key</label>
                <input
                  id="llm-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={mode === 'edit' ? '（不修改请留空）' : 'sk-ant-...'}
                  required={mode === 'create'}
                />
              </div>
            )}

            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                启用此配置
              </label>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="button" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="button button-primary" disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
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

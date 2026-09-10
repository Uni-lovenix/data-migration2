import { useState } from 'react'
import type { ReactElement } from 'react'
import { Copy, Eye, EyeOff, KeyRound, Plus, Trash2 } from 'lucide-react'

import type { ApiToken } from '../../../shared/types'
import { useApiTokens } from '../hooks/useApiTokens'

interface CreatedTokenState {
  token: ApiToken
}

export function ApiTokensPanel(): ReactElement {
  const api = useApiTokens()
  const [creating, setCreating] = useState(false)
  const [label, setLabel] = useState('')
  const [creatingError, setCreatingError] = useState<string | null>(null)
  const [justCreated, setJustCreated] = useState<CreatedTokenState | null>(null)
  const [revealed, setRevealed] = useState(false)

  async function handleCreate(): Promise<void> {
    if (!label.trim()) {
      setCreatingError('Token 名称不能为空')
      return
    }
    setCreating(true)
    setCreatingError(null)
    try {
      const created = await api.create({ label: label.trim() })
      setJustCreated({ token: created })
      setLabel('')
      setRevealed(true)
    } catch (cause) {
      setCreatingError(cause instanceof Error ? cause.message : '创建失败')
    } finally {
      setCreating(false)
    }
  }

  async function handleRevoke(id: string): Promise<void> {
    if (!window.confirm('吊销后使用此 Token 的客户端将立即收到 401。确定继续？')) return
    try {
      await api.revoke(id)
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : '吊销失败')
    }
  }

  function copy(value: string): void {
    void navigator.clipboard.writeText(value).catch(() => undefined)
  }

  return (
    <div className="api-tokens-panel">
      <div className="api-tokens-header">
        <div>
          <strong>
            <KeyRound size={16} /> API Token 管理
          </strong>
          <p className="muted">
            用于通过 REST API（http://127.0.0.1:{api.apiPort ?? '3847'}）或 Token-In 控制台接入。
            Token 创建后只显示完整值一次，请妥善保存。
          </p>
        </div>
      </div>

      <div className="api-tokens-create">
        <input
          className="input"
          placeholder="Token 名称（如：CI 流水线 / 个人令牌）"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={64}
        />
        <button
          type="button"
          className="button button-primary"
          onClick={() => void handleCreate()}
          disabled={creating || !label.trim()}
        >
          <Plus size={15} /> 创建
        </button>
      </div>
      {creatingError ? <div className="inline-error">{creatingError}</div> : null}

      {justCreated ? (
        <div className="api-token-reveal">
          <strong>新 Token 已生成</strong>
          <div className="api-token-reveal-value">
            <code>{revealed ? justCreated.token.token : justCreated.token.masked}</code>
            <button
              type="button"
              className="icon-button-ghost"
              onClick={() => setRevealed((v) => !v)}
              title={revealed ? '隐藏' : '显示'}
            >
              {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            <button
              type="button"
              className="icon-button-ghost"
              onClick={() => copy(justCreated.token.token)}
              title="复制"
            >
              <Copy size={14} />
            </button>
          </div>
          <p className="muted">标签：{justCreated.token.label}</p>
        </div>
      ) : null}

      <div className="api-tokens-list">
        {api.isLoading ? (
          <div className="empty-state">加载中…</div>
        ) : api.tokens.length === 0 ? (
          <div className="empty-state">还没有 Token</div>
        ) : (
          <ul>
            {api.tokens.map((t) => (
              <li key={t.id}>
                <div className="api-token-meta">
                  <strong>{t.label}</strong>
                  <small>
                    {t.masked} · 创建于 {new Date(t.createdAt).toLocaleString('zh-CN')}
                    {t.lastUsedAt
                      ? ` · 最近使用 ${new Date(t.lastUsedAt).toLocaleString('zh-CN')}`
                      : ''}
                  </small>
                </div>
                <button
                  type="button"
                  className="icon-button-danger"
                  onClick={() => void handleRevoke(t.id)}
                  title="吊销"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

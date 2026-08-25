import { useEffect, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'

import type {
  ConnectionConfig,
  ConnectionInput,
  ConnectionType
} from '../../../shared/types'
import {
  defaultPortForType,
  validateConnectionInput
} from '../../../shared/validation'

interface ConnectionModalProps {
  mode: 'create' | 'edit'
  connection?: ConnectionConfig
  onClose: () => void
  onSave: (input: ConnectionInput) => Promise<void>
}

interface FormState {
  name: string
  type: ConnectionType
  host: string
  port: string
  username: string
  password: string
  database: string
  defaultIndex: string
  ssl: boolean
}

function formStateFromConnection(connection?: ConnectionConfig): FormState {
  return {
    name: connection?.name ?? '',
    type: connection?.type ?? 'postgresql',
    host: connection?.host ?? '',
    port: String(connection?.port ?? defaultPortForType(connection?.type ?? 'postgresql')),
    username: connection?.username ?? '',
    password: connection?.password ?? '',
    database: connection?.database ?? '',
    defaultIndex: connection?.defaultIndex ?? '',
    ssl: connection?.ssl ?? false
  }
}

export function ConnectionModal({
  mode,
  connection,
  onClose,
  onSave
}: ConnectionModalProps): ReactElement {
  const [form, setForm] = useState<FormState>(() => formStateFromConnection(connection))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setForm(formStateFromConnection(connection))
  }, [connection])

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }))
    setError(null)
  }

  function changeType(type: ConnectionType): void {
    setForm((current) => ({
      ...current,
      type,
      port: String(defaultPortForType(type))
    }))
    setError(null)
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const result = validateConnectionInput({
      name: form.name,
      type: form.type,
      host: form.host,
      port: Number(form.port),
      username: form.username || undefined,
      password: form.password || undefined,
      database: form.type === 'postgresql' ? form.database || undefined : undefined,
      defaultIndex: form.type === 'elasticsearch' ? form.defaultIndex || undefined : undefined,
      ssl: form.ssl
    })

    if (!result.ok) {
      setError(result.errors.join('；'))
      return
    }

    setSaving(true)
    try {
      await onSave(result.value)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'create' ? '新建连接' : '编辑连接'}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{mode === 'create' ? '新建连接' : '编辑连接'}</h2>
          <button type="button" className="modal-close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        <form className="modal-body" onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label htmlFor="connection-name">名称</label>
            <input
              id="connection-name"
              value={form.name}
              onChange={(event) => updateField('name', event.target.value)}
              placeholder="例如：生产 PostgreSQL"
              autoFocus
            />
          </div>

          <div className="field">
            <label>类型</label>
            <div className="segmented">
              <button
                type="button"
                className={form.type === 'postgresql' ? 'segment segment-active' : 'segment'}
                onClick={() => changeType('postgresql')}
              >
                PostgreSQL
              </button>
              <button
                type="button"
                className={form.type === 'elasticsearch' ? 'segment segment-active' : 'segment'}
                onClick={() => changeType('elasticsearch')}
              >
                Elasticsearch
              </button>
            </div>
          </div>

          <div className="field-grid">
            <div className="field">
              <label htmlFor="connection-host">主机</label>
              <input
                id="connection-host"
                value={form.host}
                onChange={(event) => updateField('host', event.target.value)}
                placeholder="localhost"
              />
            </div>
            <div className="field">
              <label htmlFor="connection-port">端口</label>
              <input
                id="connection-port"
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(event) => updateField('port', event.target.value)}
              />
            </div>
          </div>

          <div className="field-grid">
            <div className="field">
              <label htmlFor="connection-username">用户名</label>
              <input
                id="connection-username"
                value={form.username}
                onChange={(event) => updateField('username', event.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label htmlFor="connection-password">密码</label>
              <input
                id="connection-password"
                type="password"
                value={form.password}
                onChange={(event) => updateField('password', event.target.value)}
                autoComplete="new-password"
              />
            </div>
          </div>

          {form.type === 'postgresql' ? (
            <div className="field">
              <label htmlFor="connection-database">数据库</label>
              <input
                id="connection-database"
                value={form.database}
                onChange={(event) => updateField('database', event.target.value)}
                placeholder="postgres"
              />
            </div>
          ) : (
            <div className="field">
              <label htmlFor="connection-index">默认索引</label>
              <input
                id="connection-index"
                value={form.defaultIndex}
                onChange={(event) => updateField('defaultIndex', event.target.value)}
                placeholder="my-index"
              />
            </div>
          )}

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.ssl}
              onChange={(event) => updateField('ssl', event.target.checked)}
            />
            <span>使用 SSL</span>
          </label>

          {error ? <div className="form-error">{error}</div> : null}

          <div className="modal-actions">
            <button type="button" className="button button-secondary" onClick={onClose}>
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

import { useEffect, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import { FolderOpen } from 'lucide-react'

import type {
  ConnectionConfig,
  ConnectionInput,
  ConnectionType,
  HiveAuth,
  HiveTransportMode
} from '../../../shared/types'
import { CONNECTION_TYPES } from '../../../shared/types'
import {
  connectionTypeLabel,
  defaultPortForType,
  validateConnectionInput
} from '../../../shared/validation'

interface ConnectionModalProps {
  mode: 'create' | 'edit'
  connection?: ConnectionConfig
  initialType?: ConnectionType
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
  filePath: string
  auth: HiveAuth
  transportMode: HiveTransportMode
  httpPath: string
  uri: string
  ssl: boolean
  sslCa: string
  sslCert: string
}

function formStateFromConnection(
  connection?: ConnectionConfig,
  initialType: ConnectionType = 'postgresql'
): FormState {
  const type = connection?.type ?? initialType
  return {
    name: connection?.name ?? '',
    type,
    host: connection?.host ?? '',
    port: String(connection?.port ?? defaultPortForType(type)),
    username: connection?.username ?? '',
    password: connection?.password ?? '',
    database: connection?.database ?? '',
    defaultIndex: connection?.defaultIndex ?? '',
    filePath: connection?.filePath ?? '',
    auth: connection?.auth ?? 'NONE',
    transportMode: connection?.transportMode ?? 'binary',
    httpPath: connection?.httpPath ?? '/cliservice',
    uri: connection?.uri ?? '',
    ssl: connection?.ssl ?? false,
    sslCa: connection?.sslCa ?? '',
    sslCert: connection?.sslCert ?? ''
  }
}

export function ConnectionModal({
  mode,
  connection,
  initialType,
  onClose,
  onSave
}: ConnectionModalProps): ReactElement {
  const [form, setForm] = useState<FormState>(() =>
    formStateFromConnection(connection, initialType)
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setForm(formStateFromConnection(connection, initialType))
  }, [connection, initialType])

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

  async function chooseSQLiteFile(): Promise<void> {
    try {
      const filePath = await window.api.dialog.chooseSQLiteFile()
      if (filePath) {
        updateField('filePath', filePath)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '选择数据库文件失败')
    }
  }

  async function chooseAccessFile(): Promise<void> {
    try {
      const filePath = await window.api.dialog.chooseAccessFile()
      if (filePath) {
        updateField('filePath', filePath)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '选择数据库文件失败')
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const result = validateConnectionInput({
      name: form.name,
      type: form.type,
      host: form.type === 'sqlite' || form.type === 'access' ? form.filePath : form.host,
      port: form.type === 'sqlite' || form.type === 'access' ? 0 : Number(form.port),
      username: form.username || undefined,
      password: form.password || undefined,
      database:
        form.type === 'postgresql' || form.type === 'mysql' || form.type === 'hive'
          ? form.database || undefined
          : undefined,
      defaultIndex: form.type === 'elasticsearch' ? form.defaultIndex || undefined : undefined,
      filePath:
        form.type === 'sqlite' || form.type === 'access'
          ? form.filePath || undefined
          : undefined,
      auth: form.type === 'hive' ? form.auth : undefined,
      transportMode: form.type === 'hive' ? form.transportMode : undefined,
      httpPath: form.type === 'hive' ? form.httpPath || undefined : undefined,
      uri: form.type === 'neo4j' ? form.uri || undefined : undefined,
      ssl: form.type === 'sqlite' || form.type === 'access' ? false : form.ssl,
      sslCa: form.type === 'mysql' && form.ssl ? form.sslCa || undefined : undefined,
      sslCert: form.type === 'mysql' && form.ssl ? form.sslCert || undefined : undefined
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
            <label htmlFor="connection-type">类型</label>
            <select
              id="connection-type"
              value={form.type}
              onChange={(event) => changeType(event.target.value as ConnectionType)}
            >
              {CONNECTION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {connectionTypeLabel(type)}
                </option>
              ))}
            </select>
          </div>

          {form.type === 'sqlite' || form.type === 'access' ? (
            <div className="field">
              <label htmlFor="connection-file-path">
                {form.type === 'access' ? 'Access 数据库文件' : 'SQLite 数据库文件'}
              </label>
              <div className="field-row">
                <input
                  id="connection-file-path"
                  value={form.filePath}
                  onChange={(event) => updateField('filePath', event.target.value)}
                  placeholder={
                    form.type === 'access' ? '/path/to/app.accdb' : '/path/to/app.db'
                  }
                />
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() =>
                    void (form.type === 'access' ? chooseAccessFile() : chooseSQLiteFile())
                  }
                >
                  <FolderOpen size={14} />
                  选择文件…
                </button>
              </div>
            </div>
          ) : (
            <>
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

              {form.type === 'hive' ? (
                <div className="field-grid">
                  <div className="field">
                    <label htmlFor="connection-hive-auth">认证方式</label>
                    <select
                      id="connection-hive-auth"
                      value={form.auth}
                      onChange={(event) => updateField('auth', event.target.value as HiveAuth)}
                    >
                      <option value="NONE">NONE</option>
                      <option value="LDAP">LDAP</option>
                      <option value="KERBEROS">KERBEROS</option>
                      <option value="CUSTOM">CUSTOM</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="connection-hive-transport">传输模式</label>
                    <select
                      id="connection-hive-transport"
                      value={form.transportMode}
                      onChange={(event) =>
                        updateField('transportMode', event.target.value as HiveTransportMode)
                      }
                    >
                      <option value="binary">binary</option>
                      <option value="http">http</option>
                    </select>
                  </div>
                </div>
              ) : null}

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

              {form.type === 'postgresql' ||
              form.type === 'mysql' ||
              form.type === 'hive' ? (
                <div className="field">
                  <label htmlFor="connection-database">数据库</label>
                  <input
                    id="connection-database"
                    value={form.database}
                    onChange={(event) => updateField('database', event.target.value)}
                    placeholder={
                      form.type === 'mysql'
                        ? 'mysql'
                        : form.type === 'hive'
                          ? 'default'
                          : 'postgres'
                    }
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

              {form.type === 'hive' && form.transportMode === 'http' ? (
                <div className="field">
                  <label htmlFor="connection-hive-http-path">HTTP 路径</label>
                  <input
                    id="connection-hive-http-path"
                    value={form.httpPath}
                    onChange={(event) => updateField('httpPath', event.target.value)}
                    placeholder="/cliservice"
                  />
                </div>
              ) : null}

              {form.type === 'neo4j' ? (
                <div className="field">
                  <label htmlFor="connection-neo4j-uri">Bolt URI</label>
                  <input
                    id="connection-neo4j-uri"
                    value={form.uri}
                    onChange={(event) => updateField('uri', event.target.value)}
                    placeholder="bolt://localhost:7687"
                  />
                </div>
              ) : null}

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={form.ssl}
                  onChange={(event) => updateField('ssl', event.target.checked)}
                />
                <span>使用 SSL</span>
              </label>

              {form.type === 'mysql' && form.ssl ? (
                <div className="field-grid">
                  <div className="field">
                    <label htmlFor="connection-ssl-ca">CA 证书路径</label>
                    <input
                      id="connection-ssl-ca"
                      value={form.sslCa}
                      onChange={(event) => updateField('sslCa', event.target.value)}
                      placeholder="/path/to/ca.pem"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="connection-ssl-cert">客户端证书路径</label>
                    <input
                      id="connection-ssl-cert"
                      value={form.sslCert}
                      onChange={(event) => updateField('sslCert', event.target.value)}
                      placeholder="/path/to/client-cert.pem"
                    />
                  </div>
                </div>
              ) : null}
            </>
          )}

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

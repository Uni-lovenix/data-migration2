import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  CheckCircle2,
  CircleAlert,
  KeyRound,
  Loader2,
  Play,
  RefreshCcw,
  Server,
  Workflow
} from 'lucide-react'

import type {
  MigrationTask,
  MigrationTemplate
} from '../../../shared/types'

interface ConnectionLite {
  id: string
  name: string
  type: 'postgresql' | 'elasticsearch'
  host: string
  port: number
}

interface ApiSuccess<T> {
  ok: true
  status: number
  data: T
}

interface ApiFailure {
  ok: false
  status: number
  error: string
}

type ApiResult<T> = ApiSuccess<T> | ApiFailure

const STORAGE_KEY = 'data-migrator.token-in.token'

export function TokenInPage(): ReactElement {
  const [token, setToken] = useState('')
  const [stored, setStored] = useState<string | null>(null)
  const [apiBase, setApiBase] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [connections, setConnections] = useState<ConnectionLite[]>([])
  const [templates, setTemplates] = useState<MigrationTemplate[]>([])
  const [tasks, setTasks] = useState<MigrationTask[]>([])
  const [loadingData, setLoadingData] = useState(false)
  const [executingTemplate, setExecutingTemplate] = useState<string | null>(null)

  // 加载已保存 token + api base
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      setToken(saved)
      setStored(saved)
    }
    window.api.apiTokens
      .getApiBase()
      .then((info) => setApiBase(`http://127.0.0.1:${info.port}`))
      .catch(() => undefined)
  }, [])

  const callApi = useCallback(
    async <T,>(path: string, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> => {
      const useToken = stored ?? token
      if (!useToken) {
        return { ok: false, status: 0, error: '请先填写 Token' }
      }
      try {
        const response = await window.api.restApi.call({
          method: init?.method ?? 'GET',
          path,
          body: init?.body,
          token: useToken
        })
        if (!response.ok) {
          const errorData = response.data as { error?: string } | string | null
          const message =
            (errorData && typeof errorData === 'object' && errorData.error) ||
            (typeof errorData === 'string' ? errorData : '') ||
            `HTTP ${response.status}`
          return { ok: false, status: response.status, error: message }
        }
        return { ok: true, status: response.status, data: response.data as T }
      } catch (cause) {
        return {
          ok: false,
          status: 0,
          error: cause instanceof Error ? cause.message : '网络错误'
        }
      }
    },
    [stored, token]
  )

  const verifyToken = useCallback(async (): Promise<boolean> => {
    if (!token.trim()) {
      setVerifyResult({ ok: false, message: '请先填写 Token' })
      return false
    }
    setVerifying(true)
    setVerifyResult(null)
    try {
      const result = await callApi<{ status: string }>('/api/v1/health')
      if (result.ok) {
        setStored(token.trim())
        localStorage.setItem(STORAGE_KEY, token.trim())
        setVerifyResult({ ok: true, message: 'Token 有效，已保存到本地' })
        return true
      }
      setVerifyResult({
        ok: false,
        message: result.status === 401 ? 'Token 无效或已吊销' : result.error
      })
      return false
    } finally {
      setVerifying(false)
    }
  }, [token, callApi])

  const loadData = useCallback(async () => {
    if (!stored) return
    setLoadingData(true)
    setError(null)
    try {
      const [c, t, k] = await Promise.all([
        callApi<ConnectionLite[]>('/api/v1/connections'),
        callApi<MigrationTemplate[]>('/api/v1/templates'),
        callApi<MigrationTask[]>('/api/v1/tasks')
      ])
      if (c.ok) setConnections(c.data)
      if (t.ok) setTemplates(t.data)
      if (k.ok) setTasks(k.data)
      const fails: string[] = []
      if (!c.ok) fails.push(`连接：${c.error}`)
      if (!t.ok) fails.push(`模板：${t.error}`)
      if (!k.ok) fails.push(`任务：${k.error}`)
      if (fails.length > 0) {
        setError(fails.join('；'))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载失败')
    } finally {
      setLoadingData(false)
    }
  }, [stored, callApi])

  useEffect(() => {
    if (stored) void loadData()
  }, [stored, loadData])

  async function handleExecute(template: MigrationTemplate): Promise<void> {
    setExecutingTemplate(template.id)
    setError(null)
    try {
      const result = await callApi<{ taskId: string }>(
        `/api/v1/templates/${template.id}/execute`,
        { method: 'POST', body: {} }
      )
      if (result.ok) {
        // 重新拉取任务列表
        void loadData()
      } else {
        setError(`执行失败：${result.error}`)
      }
    } finally {
      setExecutingTemplate(null)
    }
  }

  async function handleClear(): Promise<void> {
    localStorage.removeItem(STORAGE_KEY)
    setStored(null)
    setToken('')
    setVerifyResult(null)
    setConnections([])
    setTemplates([])
    setTasks([])
  }

  if (!stored) {
    return (
      <div className="page tokenin-page">
        <div className="page-heading">
          <div>
            <h1>Token-In</h1>
            <p>使用 API Token 接入 DataMigrator 远程控制台</p>
          </div>
        </div>

        <div className="tokenin-card">
          <div className="tokenin-card-head">
            <KeyRound size={22} />
            <div>
              <strong>粘贴 API Token</strong>
              <p>在「LLM 配置」页的 Token 管理中创建新 Token，然后粘贴到下方输入框。</p>
            </div>
          </div>

          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="dtm_xxxxxxxx..."
            className="input"
            spellCheck={false}
          />

          <div className="tokenin-card-actions">
            <button
              type="button"
              className="button button-primary"
              onClick={() => void verifyToken()}
              disabled={verifying || !token.trim()}
            >
              {verifying ? <Loader2 className="spin" size={15} /> : <CheckCircle2 size={15} />}
              验证 Token
            </button>
            {apiBase ? <span className="muted">API 地址：{apiBase}</span> : null}
          </div>

          {verifyResult ? (
            <div className={verifyResult.ok ? 'inline-success' : 'inline-error'}>
              {verifyResult.message}
            </div>
          ) : null}
          {error ? <div className="inline-error">{error}</div> : null}
        </div>
      </div>
    )
  }

  return (
    <div className="page tokenin-page">
      <div className="page-heading">
        <div>
          <h1>Token-In 控制台</h1>
          <p>已使用 Token 接入 · {apiBase ?? ''}</p>
        </div>
        <div className="page-heading-actions">
          <button type="button" className="button" onClick={() => void loadData()}>
            <RefreshCcw size={15} /> 刷新
          </button>
          <button type="button" className="button" onClick={() => void handleClear()}>
            退出 Token
          </button>
        </div>
      </div>

      {error ? <div className="inline-error">{error}</div> : null}

      <div className="tokenin-grid">
        <section className="card">
          <div className="card-head">
            <Server size={18} /> 数据源连接
            <span className="muted">{connections.length} 个</span>
          </div>
          {loadingData ? (
            <div className="table-empty">
              <Loader2 className="spin" size={18} /> 加载中…
            </div>
          ) : connections.length === 0 ? (
            <div className="empty-state">暂无连接</div>
          ) : (
            <ul className="tokenin-list">
              {connections.map((c) => (
                <li key={c.id}>
                  <span className={`type-dot type-dot-${c.type}`} />
                  <div className="tokenin-list-main">
                    <strong>{c.name}</strong>
                    <small>
                      {c.type} · {c.host}:{c.port}
                    </small>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <Workflow size={18} /> 迁移模板
            <span className="muted">{templates.length} 个</span>
          </div>
          {loadingData ? (
            <div className="table-empty">
              <Loader2 className="spin" size={18} /> 加载中…
            </div>
          ) : templates.length === 0 ? (
            <div className="empty-state">暂无模板</div>
          ) : (
            <ul className="tokenin-list">
              {templates.map((tmpl) => (
                <li key={tmpl.id}>
                  <span className={`badge badge-${tmpl.engine}`}>
                    {tmpl.engine}/{tmpl.action}
                  </span>
                  <div className="tokenin-list-main">
                    <strong>{tmpl.name}</strong>
                    <small>{tmpl.description ?? tmpl.connectionName}</small>
                  </div>
                  <button
                    type="button"
                    className="button button-primary button-small"
                    disabled={executingTemplate === tmpl.id}
                    onClick={() => void handleExecute(tmpl)}
                  >
                    {executingTemplate === tmpl.id ? (
                      <Loader2 className="spin" size={13} />
                    ) : (
                      <Play size={13} />
                    )}
                    执行
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card tokenin-tasks">
          <div className="card-head">
            <CircleAlert size={18} /> 最近任务
            <span className="muted">{tasks.length} 条</span>
          </div>
          {loadingData ? (
            <div className="table-empty">
              <Loader2 className="spin" size={18} /> 加载中…
            </div>
          ) : tasks.length === 0 ? (
            <div className="empty-state">暂无任务</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>进度</th>
                </tr>
              </thead>
              <tbody>
                {tasks.slice(0, 20).map((task) => (
                  <tr key={task.id}>
                    <td>
                      <code>{task.id.slice(0, 8)}</code>
                    </td>
                    <td>{task.type}</td>
                    <td>
                      <span className={`badge badge-${task.status}`}>{task.status}</span>
                    </td>
                    <td>{Math.round(task.progress)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  )
}

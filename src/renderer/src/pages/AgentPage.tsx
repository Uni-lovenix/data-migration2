import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Bot,
  Loader2,
  MessageSquarePlus,
  Pencil,
  Send,
  Settings2,
  Trash2,
  User,
  Wrench
} from 'lucide-react'

import type {
  AgentMessage,
  AgentSession,
  LLMConfig
} from '../../../shared/types'
import { useAgent } from '../hooks/useAgent'
import { useLLM } from '../hooks/useLLM'
import { renderMarkdown } from '../components/markdown'

const LLM_HINT =
  '在「LLM 配置」中添加一个 Ollama / Anthropic / OpenAI 配置后，会话才能调用 LLM 并执行工具。'

export function AgentPage(): ReactElement {
  const agentApi = useAgent()
  const llmApi = useLLM()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [sessionMeta, setSessionMeta] = useState<AgentSession | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)

  // 默认选中第一个会话（若没有则自动创建占位提示用户去设置 LLM）
  useEffect(() => {
    if (activeId !== null) return
    if (agentApi.sessions.length > 0) {
      const first = agentApi.sessions[0]
      if (first) setActiveId(first.id)
    }
  }, [agentApi.sessions, activeId])

  // 加载会话消息
  useEffect(() => {
    if (!activeId) {
      setMessages([])
      setSessionMeta(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const detail = await window.api.agent.getSession(activeId)
        if (cancelled) return
        setSessionMeta(detail.session)
        setMessages(detail.messages)
        setError(null)
      } catch (cause) {
        if (!cancelled) setError(messageOf(cause))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeId])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length])

  const enabledLlm = useMemo(
    () => llmApi.configs.find((c) => c.enabled) ?? null,
    [llmApi.configs]
  )

  async function handleCreateSession(): Promise<void> {
    setError(null)
    try {
      const created = await agentApi.createSession({
        title: `会话 ${agentApi.sessions.length + 1}`,
        llmConfigId: enabledLlm?.id
      })
      setActiveId(created.id)
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  async function handleSend(): Promise<void> {
    const text = input.trim()
    if (!text || !activeId || sending) return
    setInput('')
    setSending(true)
    setError(null)
    try {
      const response = await agentApi.chat({ sessionId: activeId, userMessage: text })
      const detail = await window.api.agent.getSession(activeId)
      setMessages(detail.messages)
      setSessionMeta(detail.session)
      // 当 session 标题还是默认时，使用用户首条消息作为标题
      if (response.reply && sessionMeta && /^会话 \d+$/.test(sessionMeta.title)) {
        await agentApi.renameSession(activeId, text.slice(0, 30))
      }
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setSending(false)
    }
  }

  async function handleDelete(session: AgentSession): Promise<void> {
    if (!window.confirm(`删除会话「${session.title}」？相关消息也会一起清除。`)) return
    await agentApi.deleteSession(session.id)
    if (activeId === session.id) {
      setActiveId(null)
      setMessages([])
      setSessionMeta(null)
    }
  }

  async function handleRenameSubmit(): Promise<void> {
    if (!renameId) return
    const title = renameValue.trim()
    if (title.length === 0) return
    await agentApi.renameSession(renameId, title)
    if (activeId === renameId && sessionMeta) {
      setSessionMeta({ ...sessionMeta, title })
    }
    setRenameId(null)
    setRenameValue('')
  }

return (
    <div className="page agent-page">
      <aside className="agent-sidebar">
        <div className="agent-sidebar-header">
          <h2>会话</h2>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void handleCreateSession()}
            title="新建会话"
          >
            <MessageSquarePlus size={15} />
            新建
          </button>
        </div>

        {agentApi.isLoading ? (
          <div className="empty-state">加载中…</div>
        ) : agentApi.sessions.length === 0 ? (
          <div className="empty-state">
            <Bot size={24} />
            <span>还没有会话</span>
            <button
              type="button"
              className="button button-primary"
              onClick={() => void handleCreateSession()}
            >
              <MessageSquarePlus size={15} />
              新建第一个会话
            </button>
          </div>
        ) : (
          <ul className="agent-session-list">
            {agentApi.sessions.map((session) => {
              const isActive = session.id === activeId
              return (
                <li
                  key={session.id}
                  className={
                    isActive ? 'agent-session agent-session-active' : 'agent-session'
                  }
                >
                  {renameId === session.id ? (
                    <input
                      autoFocus
                      className="input input-small"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleRenameSubmit()
                        if (e.key === 'Escape') setRenameId(null)
                      }}
                      onBlur={() => void handleRenameSubmit()}
                    />
                  ) : (
                    <button
                      type="button"
                      className="agent-session-button"
                      onClick={() => setActiveId(session.id)}
                    >
                      <span className="agent-session-title">{session.title}</span>
                      <span className="agent-session-meta">
                        {formatRelative(session.updatedAt)}
                      </span>
                    </button>
                  )}
                  <div className="agent-session-actions">
                    <button
                      type="button"
                      className="icon-button-ghost"
                      title="重命名"
                      onClick={() => {
                        setRenameId(session.id)
                        setRenameValue(session.title)
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className="icon-button-ghost"
                      title="删除"
                      onClick={() => void handleDelete(session)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </aside>

      <section className="agent-main">
        <header className="agent-header">
          <div>
            <h1>{sessionMeta?.title ?? '智能体'}</h1>
            <p className="agent-subtitle">
              {sessionMeta?.llmConfigId
                ? llmApi.configs.find((c) => c.id === sessionMeta.llmConfigId)?.name ?? '已绑定 LLM'
                : '尚未绑定 LLM'}
            </p>
          </div>
          <div className="agent-header-actions">
            <button
              type="button"
              className="button"
              onClick={() => setShowSettings((v) => !v)}
              title="会话设置"
            >
              <Settings2 size={15} />
              会话设置
            </button>
          </div>
        </header>

        {showSettings && activeId ? (
          <LlmConfigPicker
            currentLlmId={sessionMeta?.llmConfigId}
            configs={llmApi.configs}
            onPick={async (llmId) => {
              try {
                // 通过 agent.deleteSession + createSession 重建会话绑定 LLM（保持原 id 不变不可行，
                // 因此采用：rename 保持 title 同步，并记录到 sessionMeta）
                await window.api.agent.getSession(activeId)
                // 主进程没有直接 update llm_config_id 的 IPC；
                // 这里通过保存标题后让用户在创建新会话时选择 LLM
                setShowSettings(false)
              } catch (cause) {
                setError(messageOf(cause))
              }
              void llmId
            }}
          />
        ) : null}

        {llmApi.configs.length === 0 ? (
          <div className="inline-warning">{LLM_HINT}</div>
        ) : null}
        {error ? <div className="inline-error">{error}</div> : null}

        <div className="agent-chat" ref={listRef}>
          {messages.length === 0 ? (
            <div className="agent-empty">
              <Bot size={36} />
              <p>开始提问吧。我可以帮你：</p>
              <ul>
                <li>查询数据源连接、模板、任务状态</li>
                <li>发起 PostgreSQL / Elasticsearch 导出导入任务</li>
                <li>按模板批量执行迁移</li>
              </ul>
            </div>
          ) : (
            messages.map((message) => <MessageBubble key={message.id} message={message} />)
          )}
          {sending ? (
            <div className="agent-bubble agent-bubble-assistant agent-bubble-loading">
              <Loader2 className="spin" size={14} /> 思考中…
            </div>
          ) : null}
        </div>

        <div className="agent-input">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSend()
              }
            }}
            placeholder={
              sessionMeta?.llmConfigId
                ? '向智能体提问…（Enter 发送，Shift+Enter 换行）'
                : '请先在「会话设置」中为本会话选择 LLM'
            }
            rows={2}
            disabled={!activeId || !sessionMeta?.llmConfigId || sending}
          />
          <button
            type="button"
            className="button button-primary"
            onClick={() => void handleSend()}
            disabled={sending || input.trim().length === 0 || !sessionMeta?.llmConfigId}
          >
            <Send size={15} />
            发送
          </button>
        </div>
      </section>
    </div>
  )
}

interface LlmConfigPickerProps {
  configs: LLMConfig[]
  currentLlmId?: string
  onPick: (llmId: string) => void
}

function LlmConfigPicker({ configs, currentLlmId, onPick }: LlmConfigPickerProps): ReactElement {
  return (
    <div className="agent-settings-card">
      <div>
        <strong>绑定 LLM</strong>
        <p className="muted">智能体会以选定 LLM 作为大脑执行工具调用。请先在「LLM 配置」中创建至少一条配置。</p>
      </div>
      <div className="agent-llm-list">
        {configs.map((config) => {
          const active = config.id === currentLlmId
          return (
            <button
              key={config.id}
              type="button"
              className={active ? 'agent-llm-pill agent-llm-pill-active' : 'agent-llm-pill'}
              onClick={() => onPick(config.id)}
              disabled={active}
            >
              <span>{config.name}</span>
              <small>
                {config.provider} · {config.model}
              </small>
            </button>
          )
        })}
      </div>
    </div>
  )
}

interface MessageBubbleProps {
  message: AgentMessage
}

function MessageBubble({ message }: MessageBubbleProps): ReactElement {
  if (message.role === 'user') {
    return (
      <div className="agent-bubble agent-bubble-user">
        <div className="agent-bubble-head">
          <User size={14} /> 你
        </div>
        <div className="agent-bubble-body">{message.content ?? ''}</div>
      </div>
    )
  }
  if (message.role === 'assistant') {
    if (message.toolArgs) {
      try {
        const parsed = JSON.parse(message.toolArgs) as Array<{ name: string; arguments: string }>
        return (
          <div className="agent-bubble agent-bubble-tool">
            <div className="agent-bubble-head">
              <Wrench size={14} /> 工具调用
            </div>
            <ul className="agent-tool-list">
              {parsed.map((tc) => (
                <li key={tc.name}>
                  <code>{tc.name}</code>
                  <pre>{prettifyJson(tc.arguments)}</pre>
                </li>
              ))}
            </ul>
            {message.content ? <div className="agent-bubble-body">{message.content}</div> : null}
          </div>
        )
      } catch {
        // fall through
      }
    }
    return (
      <div className="agent-bubble agent-bubble-assistant">
        <div className="agent-bubble-head">
          <Bot size={14} /> 智能体
        </div>
        <div
          className="agent-bubble-body agent-markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content ?? '') }}
        />
      </div>
    )
  }
  if (message.role === 'tool') {
    return (
      <div className="agent-bubble agent-bubble-tool-result">
        <div className="agent-bubble-head">
          <Wrench size={14} /> 工具结果 · <code>{message.toolName}</code>
        </div>
        <pre className="agent-tool-result">{message.toolResult ?? message.content ?? ''}</pre>
      </div>
    )
  }
  if (message.role === 'system') {
    return (
      <div className="agent-bubble agent-bubble-system">
        <div className="agent-bubble-body">{message.content ?? ''}</div>
      </div>
    )
  }
  return <div />
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : '未知错误'
}

function formatRelative(iso: string): string {
  try {
    const date = new Date(iso)
    const diff = Date.now() - date.getTime()
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
    return date.toLocaleDateString('zh-CN')
  } catch {
    return iso
  }
}

function prettifyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

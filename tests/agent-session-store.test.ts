import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { AgentSessionStore } from '../src/main/agent-session-store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

async function createStore(): Promise<AgentSessionStore> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-session-test-'))
  temporaryDirectories.push(directory)
  const store = new AgentSessionStore(join(directory, 'sessions.db'))
  await store.initialize()
  return store
}

describe('AgentSessionStore', () => {
  it('初始化后无会话', async () => {
    const store = await createStore()
    expect(store.listSessions()).toEqual([])
  })

  it('创建会话后能在列表中查到', async () => {
    const store = await createStore()
    const session = store.createSession({ title: '测试会话' })
    expect(session.title).toBe('测试会话')
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/)
    const list = store.listSessions()
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe(session.id)
  })

  it('创建会话时未传标题使用默认值', async () => {
    const store = await createStore()
    const session = store.createSession({})
    expect(session.title).toBe('新会话')
  })

  it('重命名会话', async () => {
    const store = await createStore()
    const session = store.createSession({ title: '原始' })
    const renamed = store.renameSession(session.id, '新标题')
    expect(renamed.title).toBe('新标题')
    expect(store.getSession(session.id).title).toBe('新标题')
  })

  it('空标题拒绝', async () => {
    const store = await createStore()
    const session = store.createSession({ title: 'x' })
    expect(() => store.renameSession(session.id, '   ')).toThrow(/会话标题/)
  })

  it('添加消息并按时间序返回', async () => {
    const store = await createStore()
    const session = store.createSession({ title: 't' })
    store.appendMessage(session.id, 'user', '你好')
    store.appendMessage(session.id, 'assistant', '你好，我可以帮你')
    store.appendMessage(session.id, 'tool', '{"ok":true}', {
      toolCallId: 'call_1',
      toolName: 'list_connections',
      toolResult: '{}'
    })
    const messages = store.listMessages(session.id)
    expect(messages).toHaveLength(3)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(messages[2]?.toolCallId).toBe('call_1')
    expect(messages[2]?.toolName).toBe('list_connections')
  })

  it('删除会话同时删除消息', async () => {
    const store = await createStore()
    const session = store.createSession({ title: 't' })
    store.appendMessage(session.id, 'user', 'hi')
    store.deleteSession(session.id)
    expect(store.listSessions()).toHaveLength(0)
    expect(store.listMessages(session.id)).toHaveLength(0)
  })

  it('切换会话 LLM 配置', async () => {
    const store = await createStore()
    const session = store.createSession({ title: 't' })
    const updated = store.setSessionLlmConfig(session.id, 'llm-123')
    expect(updated.llmConfigId).toBe('llm-123')
    store.setSessionLlmConfig(session.id, undefined)
    expect(store.getSession(session.id).llmConfigId).toBeUndefined()
  })

  it('清空消息', async () => {
    const store = await createStore()
    const session = store.createSession({ title: 't' })
    store.appendMessage(session.id, 'user', 'a')
    store.appendMessage(session.id, 'assistant', 'b')
    store.clearMessages(session.id)
    expect(store.listMessages(session.id)).toHaveLength(0)
    expect(store.listSessions()).toHaveLength(1)
  })

  it('未知会话抛错', async () => {
    const store = await createStore()
    expect(() => store.getSession('not-exist')).toThrow(/不存在/)
  })
})

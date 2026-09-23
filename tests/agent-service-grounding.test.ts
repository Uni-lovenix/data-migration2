import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentService } from '../src/main/agent-service'
import { AgentSessionStore } from '../src/main/agent-session-store'
import type { MigrationTask } from '../src/shared/types'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

async function createFixture(tasks: MigrationTask[]): Promise<{
  service: AgentService
  sessions: AgentSessionStore
  sessionId: string
  llmGet: ReturnType<typeof vi.fn>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-grounding-test-'))
  temporaryDirectories.push(directory)
  const sessions = new AgentSessionStore(join(directory, 'agent-sessions.db'))
  await sessions.initialize()
  const session = sessions.createSession({ title: '测试会话', llmConfigId: 'llm-test' })
  const llmGet = vi.fn(() => {
    throw new Error('确定性只读查询不应调用 LLM')
  })
  const service = new AgentService({
    sessions,
    llmStore: {
      get: llmGet,
      getDecryptedApiKey: vi.fn()
    } as never,
    connections: {} as never,
    templates: {} as never,
    taskManager: {
      list: () => tasks
    } as never,
    orchestration: {} as never
  })
  return { service, sessions, sessionId: session.id, llmGet }
}

function task(
  overrides: Partial<MigrationTask> & Pick<MigrationTask, 'id' | 'createdAt'>
): MigrationTask {
  return {
    type: 'mysql-export',
    status: 'completed',
    connectionId: 'connection-1',
    payload: {} as MigrationTask['payload'],
    progress: 100,
    ...overrides
  }
}

describe('AgentService read-only grounding', () => {
  it('answers task-count questions from the live task store without invoking the LLM', async () => {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0)
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    const todayTask = task({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: today.toISOString(),
      startedAt: today.toISOString(),
      finishedAt: today.toISOString()
    })
    const oldTask = task({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      createdAt: yesterday.toISOString(),
      status: 'failed',
      error: 'connection refused'
    })
    const { service, sessions, sessionId, llmGet } = await createFixture([
      todayTask,
      oldTask
    ])

    const response = await service.chat({
      sessionId,
      userMessage: '今天执行来多少任务？'
    })

    expect(response.toolCalls).toEqual([
      {
        name: 'list_tasks',
        args: {},
        result: expect.objectContaining({
          count: 2,
          todayCount: 1,
          todayStartedCount: 1
        })
      }
    ])
    expect(response.reply).toContain('今天创建/下发 1 个')
    expect(response.reply).toContain(todayTask.id)
    expect(response.reply).not.toContain('2521')
    expect(llmGet).not.toHaveBeenCalled()

    const messages = sessions.listMessages(sessionId)
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant'
    ])
    expect(messages[2]?.toolName).toBe('list_tasks')
    expect(messages[2]?.content).toContain(todayTask.id)
  })

  it('rechecks task data when the user corrects a previous no-task answer', async () => {
    const now = new Date()
    const createdToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      11,
      0,
      0
    )
    const realTask = task({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      createdAt: createdToday.toISOString(),
      status: 'failed',
      error: 'connection refused'
    })
    const { service, sessions, sessionId } = await createFixture([realTask])
    sessions.appendMessage(sessionId, 'user', '今天下发了多少任务？')
    sessions.appendMessage(sessionId, 'assistant', '今天没有下发任务。')

    const response = await service.chat({
      sessionId,
      userMessage: '有的啊'
    })

    expect(response.toolCalls[0]?.name).toBe('list_tasks')
    expect(response.reply).toContain('今天创建/下发 1 个')
    expect(response.reply).toContain(realTask.id)
    expect(response.reply).not.toContain('2521')
  })
})

import { useCallback, useEffect, useState } from 'react'

import type {
  AgentChatRequest,
  AgentChatResponse,
  AgentMessage,
  AgentSession,
  AgentSessionInput
} from '../../../shared/types'

export interface AgentApi {
  sessions: AgentSession[]
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
  getSession: (id: string) => Promise<{ session: AgentSession; messages: AgentMessage[] }>
  createSession: (input: AgentSessionInput) => Promise<AgentSession>
  renameSession: (id: string, title: string) => Promise<AgentSession>
  deleteSession: (id: string) => Promise<void>
  chat: (request: AgentChatRequest) => Promise<AgentChatResponse>
  clearMessages: (id: string) => Promise<void>
}

export function useAgent(): AgentApi {
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await window.api.agent.listSessions()
      setSessions(next)
      setError(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const getSession = useCallback(async (id: string) => {
    return window.api.agent.getSession(id)
  }, [])

  const createSession = useCallback(async (input: AgentSessionInput) => {
    const created = await window.api.agent.createSession(input)
    setSessions((current) => [created, ...current])
    return created
  }, [])

  const renameSession = useCallback(async (id: string, title: string) => {
    const updated = await window.api.agent.renameSession(id, title)
    setSessions((current) => current.map((s) => (s.id === id ? updated : s)))
    return updated
  }, [])

  const deleteSession = useCallback(async (id: string) => {
    await window.api.agent.deleteSession(id)
    setSessions((current) => current.filter((s) => s.id !== id))
  }, [])

  const chat = useCallback(async (request: AgentChatRequest) => {
    return window.api.agent.chat(request)
  }, [])

  const clearMessages = useCallback(async (id: string) => {
    await window.api.agent.deleteSession(id)
    await refresh()
  }, [refresh])

  return {
    sessions,
    isLoading,
    error,
    refresh,
    getSession,
    createSession,
    renameSession,
    deleteSession,
    chat,
    clearMessages
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败'
}

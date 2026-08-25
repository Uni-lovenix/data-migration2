import { useCallback, useEffect, useState } from 'react'

import type { ConnectionConfig, ConnectionInput } from '../../../shared/types'

export interface ConnectionsApi {
  connections: ConnectionConfig[]
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
  create: (input: ConnectionInput) => Promise<ConnectionConfig>
  update: (id: string, input: ConnectionInput) => Promise<ConnectionConfig>
  remove: (id: string) => Promise<void>
}

export function useConnections(): ConnectionsApi {
  const [connections, setConnections] = useState<ConnectionConfig[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await window.api.connections.list()
      setConnections(next)
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

  const create = useCallback(async (input: ConnectionInput) => {
    const created = await window.api.connections.create(input)
    setConnections((current) => [...current, created])
    return created
  }, [])

  const update = useCallback(async (id: string, input: ConnectionInput) => {
    const updated = await window.api.connections.update(id, input)
    setConnections((current) =>
      current.map((item) => (item.id === id ? updated : item))
    )
    return updated
  }, [])

  const remove = useCallback(async (id: string) => {
    await window.api.connections.delete(id)
    setConnections((current) => current.filter((item) => item.id !== id))
  }, [])

  return {
    connections,
    isLoading,
    error,
    refresh,
    create,
    update,
    remove
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败'
}

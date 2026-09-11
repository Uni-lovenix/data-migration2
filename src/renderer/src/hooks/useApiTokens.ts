import { useCallback, useEffect, useState } from 'react'

import type { ApiToken, ApiTokenInput, ApiTokenView } from '../../../shared/types'

export interface ApiTokensApi {
  tokens: ApiTokenView[]
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
  create: (input: ApiTokenInput) => Promise<ApiToken>
  revoke: (id: string) => Promise<void>
  apiPort: number | null
}

export function useApiTokens(): ApiTokensApi {
  const [tokens, setTokens] = useState<ApiTokenView[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [apiPort, setApiPort] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [next, portInfo] = await Promise.all([
        window.api.apiTokens.list(),
        window.api.apiTokens.getApiBase()
      ])
      setTokens(next)
      setApiPort(portInfo.port)
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

  const create = useCallback(async (input: ApiTokenInput) => {
    const created = await window.api.apiTokens.create(input)
    setTokens((current) => [
      ...current,
      {
        id: created.id,
        label: created.label,
        masked: created.masked,
        createdAt: created.createdAt,
        lastUsedAt: created.lastUsedAt
      }
    ])
    return created
  }, [])

  const revoke = useCallback(async (id: string) => {
    await window.api.apiTokens.revoke(id)
    setTokens((current) => current.filter((t) => t.id !== id))
  }, [])

  return { tokens, isLoading, error, refresh, create, revoke, apiPort }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败'
}

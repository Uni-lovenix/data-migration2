import { useCallback, useEffect, useState } from 'react'

import type { LLMConfig, LLMConfigInput, UpdateLLMConfigInput } from '../../../shared/types'

export interface LLMApi {
  configs: LLMConfig[]
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
  create: (input: LLMConfigInput) => Promise<LLMConfig>
  update: (id: string, input: UpdateLLMConfigInput) => Promise<LLMConfig>
  remove: (id: string) => Promise<void>
  toggle: (id: string) => Promise<LLMConfig>
}

export function useLLM(): LLMApi {
  const [configs, setConfigs] = useState<LLMConfig[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await window.api.llm.list()
      setConfigs(next)
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

  const create = useCallback(async (input: LLMConfigInput) => {
    const created = await window.api.llm.create(input)
    setConfigs((current) => [...current, created])
    return created
  }, [])

  const update = useCallback(async (id: string, input: UpdateLLMConfigInput) => {
    const updated = await window.api.llm.update(id, input)
    setConfigs((current) =>
      current.map((item) => (item.id === id ? updated : item))
    )
    return updated
  }, [])

  const remove = useCallback(async (id: string) => {
    await window.api.llm.delete(id)
    setConfigs((current) => current.filter((item) => item.id !== id))
  }, [])

  const toggle = useCallback(async (id: string) => {
    const current = configs.find((c) => c.id === id)
    if (!current) {
      throw new Error('配置不存在')
    }
    const updated = await window.api.llm.update(id, { enabled: !current.enabled })
    setConfigs((current) =>
      current.map((item) => (item.id === id ? updated : item))
    )
    return updated
  }, [configs])

  return {
    configs,
    isLoading,
    error,
    refresh,
    create,
    update,
    remove,
    toggle
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败'
}

import type { LLMProvider } from '../../../shared/types'

export const LLMProviderLabels: Record<LLMProvider, string> = {
  ollama: 'Ollama',
  anthropic: 'Anthropic',
  openai: 'OpenAI'
}

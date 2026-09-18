import { describe, expect, it } from 'vitest'

import {
  parseOpenAILikeResponse,
  serializeMessageForOllama,
  type ChatMessage
} from '../src/main/agent-service'

describe('Ollama compatibility', () => {
  it('parses Ollama top-level message, usage and tool calls', () => {
    const parsed = parseOpenAILikeResponse({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            function: {
              name: 'list_connections',
              arguments: { includePasswords: false }
            }
          }
        ]
      },
      prompt_eval_count: 12,
      eval_count: 4
    })

    expect(parsed.message.toolCalls).toEqual([
      {
        id: expect.any(String),
        function: {
          name: 'list_connections',
          arguments: '{"includePasswords":false}'
        }
      }
    ])
    expect(parsed.usage).toEqual({
      promptTokens: 12,
      completionTokens: 4,
      totalTokens: 16
    })
  })

  it('serializes assistant tool calls and tool results for Ollama', () => {
    const assistant: ChatMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'list_connections',
            arguments: '{"limit":10}'
          }
        }
      ]
    }
    expect(serializeMessageForOllama(assistant)).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          function: {
            name: 'list_connections',
            arguments: { limit: 10 }
          }
        }
      ]
    })

    const tool: ChatMessage = {
      role: 'tool',
      tool_call_id: 'call-1',
      content: '{"count":0}'
    }
    expect(serializeMessageForOllama(tool)).toEqual({
      role: 'tool',
      content: '{"count":0}'
    })
  })
})

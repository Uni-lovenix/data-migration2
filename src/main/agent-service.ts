import { randomUUID } from 'node:crypto'

import type {
  AgentChatRequest,
  AgentChatResponse,
  AgentMessage,
  AgentRole,
  AgentSessionInput,
  AgentSession,
  LLMConfig,
  CastDryRunRequest,
  ExportPreviewRequest,
  ImportValidateRequest
} from '../shared/types'
import type { AgentSessionStore } from './agent-session-store'
import type { ConnectionStore } from './connection-store'
import type { LLMStore } from './llm-store'
import type { TaskManager } from './task-manager'
import type { TemplateStore } from './template-store'
import type { OrchestrationService } from './orchestration-service'
import { buildStepDescriptors, resolveTaskInput } from './template-utils'

/**
 * AgentService — 参考 AIIP agent.py 的实现：
 *
 *   1. 构造带"当前日期/锚点"的 system prompt
 *   2. 把工具 schema 注入（function calling）
 *   3. 循环：调用 LLM → 如果有 tool_calls 就执行工具 → 把结果回传 → 再调用
 *   4. 最终把 assistant 消息落库
 *
 * 工具全部在主进程内执行，通过 TaskManager / TemplateStore / ConnectionStore
 * 调用现有的迁移引擎；不会暴露在渲染层或外部 REST API 中。
 */

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
  | { role: 'tool'; tool_call_id: string; content: string }

interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, ToolPropertySchema>
    required?: string[]
  }
}

interface ToolPropertySchema {
  type: string
  description?: string
  enum?: string[]
  items?: ToolPropertySchema
  properties?: Record<string, ToolPropertySchema>
  required?: string[]
  additionalProperties?: boolean
}

interface AgentServiceOptions {
  sessions: AgentSessionStore
  llmStore: LLMStore
  connections: ConnectionStore
  templates: TemplateStore
  taskManager: TaskManager
  orchestration: OrchestrationService
}

export class AgentService {
  private readonly sessions: AgentSessionStore
  private readonly llmStore: LLMStore
  private readonly connections: ConnectionStore
  private readonly templates: TemplateStore
  private readonly taskManager: TaskManager
  private readonly orchestration: OrchestrationService

  constructor(options: AgentServiceOptions) {
    this.sessions = options.sessions
    this.llmStore = options.llmStore
    this.connections = options.connections
    this.templates = options.templates
    this.taskManager = options.taskManager
    this.orchestration = options.orchestration
  }

  // ============ 会话管理 ============

  listSessions(): AgentSession[] {
    return this.sessions.listSessions()
  }

  getSession(id: string): AgentSession {
    return this.sessions.getSession(id)
  }

  createSession(input: AgentSessionInput): AgentSession {
    return this.sessions.createSession(input)
  }

  renameSession(id: string, title: string): AgentSession {
    return this.sessions.renameSession(id, title)
  }

  deleteSession(id: string): void {
    this.sessions.deleteSession(id)
  }

  listMessages(sessionId: string): AgentMessage[] {
    return this.sessions.listMessages(sessionId)
  }

  clearMessages(sessionId: string): void {
    this.sessions.clearMessages(sessionId)
  }

  setSessionLlmConfig(sessionId: string, llmConfigId: string | undefined): AgentSession {
    this.sessions.setSessionLlmConfig(sessionId, llmConfigId)
    return this.sessions.getSession(sessionId)
  }

  // ============ 主对话入口 ============

  async chat(request: AgentChatRequest): Promise<AgentChatResponse> {
    const session = this.sessions.getSession(request.sessionId)

    // 1. 记录用户消息
    this.sessions.appendMessage(session.id, 'user', request.userMessage)

    // 2. 构造对话历史
    const history = this.sessions.listMessages(session.id)
    const groundedRead = await this.resolveReadOnlyQuery(history)
    if (groundedRead) {
      const callId = randomUUID()
      const resultStr = serializeToolResult(groundedRead.result)
      this.sessions.appendMessage(session.id, 'assistant', '', {
        toolArgs: JSON.stringify([
          {
            id: callId,
            name: groundedRead.toolName,
            arguments: JSON.stringify(groundedRead.args)
          }
        ])
      })
      this.sessions.appendMessage(session.id, 'tool', resultStr, {
        toolCallId: callId,
        toolName: groundedRead.toolName,
        toolResult: resultStr
      })
      this.sessions.appendMessage(session.id, 'assistant', groundedRead.reply)
      return {
        sessionId: session.id,
        reply: groundedRead.reply,
        toolCalls: [
          {
            name: groundedRead.toolName,
            args: groundedRead.args,
            result: groundedRead.result
          }
        ]
      }
    }

    const llmConfigId = session.llmConfigId
    if (!llmConfigId) {
      throw new Error('会话未配置 LLM，请先在会话设置中选择一个 LLM 配置')
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt() },
      ...history.flatMap(messageToChatMessage)
    ]

    // 3. 工具调用循环
    const toolCallRecords: AgentChatResponse['toolCalls'] = []
    const tools = this.buildToolDefinitions()
    let finalReply = ''
    let usage: AgentChatResponse['usage'] | undefined
    const maxIterations = 8
    let iterations = 0

    while (iterations < maxIterations) {
      iterations += 1
      const response = await this.callLLM(llmConfigId, messages, tools)
      usage = response.usage ?? usage
      const assistantMessage = response.message

      // 没有工具调用 → 直接是最终回复
      if (assistantMessage.toolCalls.length === 0) {
        finalReply = assistantMessage.content ?? ''
        messages.push({ role: 'assistant', content: finalReply || '' })
        this.sessions.appendMessage(session.id, 'assistant', finalReply || '')
        break
      }

      // 持久化 assistant tool_calls 消息
      this.sessions.appendMessage(
        session.id,
        'assistant',
        assistantMessage.content,
        {
          toolArgs: JSON.stringify(
            assistantMessage.toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments
            }))
          )
        }
      )

      messages.push({
        role: 'assistant',
        content: assistantMessage.content,
        tool_calls: assistantMessage.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments }
        }))
      })

      // 4. 依次执行每个工具调用
      for (const tc of assistantMessage.toolCalls) {
        const args = safeParseJson(tc.function.arguments)
        let result: unknown
        try {
          result = await this.dispatchTool(tc.function.name, args)
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) }
        }
        const resultStr = serializeToolResult(result)
        toolCallRecords.push({
          name: tc.function.name,
          args,
          result
        })

        this.sessions.appendMessage(session.id, 'tool', resultStr, {
          toolCallId: tc.id,
          toolName: tc.function.name,
          toolResult: resultStr
        })

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resultStr
        })
      }
    }

    if (iterations >= maxIterations && finalReply === '') {
      finalReply = '工具调用次数已达上限，未能生成最终回复。请尝试简化需求。'
      this.sessions.appendMessage(session.id, 'assistant', finalReply)
    }

    return {
      sessionId: session.id,
      reply: finalReply,
      toolCalls: toolCallRecords,
      ...(usage ? { usage } : {})
    }
  }

  // ============ LLM 调用 ============

  private async callLLM(
    llmConfigId: string,
    messages: ChatMessage[],
    tools: ToolDefinition[]
  ): Promise<{
    message: { content: string | null; toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> }
    usage?: AgentChatResponse['usage']
  }> {
    const config = this.llmStore.get(llmConfigId)
    const apiKey = this.llmStore.getDecryptedApiKey(llmConfigId)
    if (!apiKey && config.provider !== 'ollama') {
      throw new Error('LLM API Key 不可用')
    }

    const model = config.model
    const base = config.apiBase ?? defaultBase(config.provider)
    let url: string
    let headers: Record<string, string>
    let body: Record<string, unknown>

    if (config.provider === 'ollama') {
      url = `${base}/api/chat`
      headers = { 'Content-Type': 'application/json' }
      body = {
        model,
        messages: messages.map(serializeMessageForOllama),
        tools: tools.map(toOllamaTool),
        stream: false
      }
    } else if (config.provider === 'anthropic') {
      url = `${base}/v1/messages`
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey ?? '',
        'anthropic-version': '2023-06-01'
      }
      const systemMessage = messages.find((m) => m.role === 'system')?.content as string | undefined
      const nonSystem = messages.filter((m) => m.role !== 'system')
      body = {
        model,
        system: systemMessage,
        messages: nonSystem.map(serializeMessageForAnthropic),
        tools: tools.map(toAnthropicTool),
        max_tokens: 4096
      }
    } else {
      url = `${base}/v1/chat/completions`
      headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey ?? ''}`
      }
      body = {
        model,
        messages: messages.map(serializeMessageForOpenAI),
        tools: tools.map(toOpenAITool),
        max_tokens: 4096
      }
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      })
    } catch (err) {
      throw new Error(`LLM 网络请求失败：${err instanceof Error ? err.message : String(err)}`)
    }

    if (response.status === 401) {
      throw new Error('LLM 认证失败（401），请检查 API Key')
    }
    if (response.status === 403) {
      throw new Error('LLM 权限被拒绝（403），请检查 API Key 权限或配额')
    }
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`LLM 调用失败（${response.status}）：${text.slice(0, 500)}`)
    }

    const data = (await response.json()) as Record<string, unknown>
    return config.provider === 'anthropic'
      ? parseAnthropicResponse(data)
      : parseOpenAILikeResponse(data)
  }

  // ============ 工具实现 ============

  private async dispatchTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    switch (name) {
      case 'list_connections':
        return this.toolListConnections()
      case 'get_connection':
        return this.toolGetConnection(stringArg(args, 'id'))
      case 'list_templates':
        return this.toolListTemplates()
      case 'execute_template':
        return this.toolExecuteTemplate(stringArg(args, 'id'), args['vars'] as Record<string, string> | undefined)
      case 'list_tasks':
        return this.toolListTasks()
      case 'get_task':
        return this.toolGetTask(stringArg(args, 'id'))
      case 'cancel_task':
        return this.toolCancelTask(stringArg(args, 'id'))
      case 'run_postgres_export':
        return this.toolRunPostgresExport(args)
      case 'run_postgres_import':
        return this.toolRunPostgresImport(args)
      case 'run_elasticsearch_export':
        return this.toolRunElasticsearchExport(args)
      case 'run_elasticsearch_import':
        return this.toolRunElasticsearchImport(args)
      case 'list_llm_configs':
        return this.toolListLLMConfigs()
      case 'export_preview':
        return this.orchestration.exportPreview(args as unknown as ExportPreviewRequest)
      case 'import_validate':
        return this.orchestration.importValidate(args as unknown as ImportValidateRequest)
      case 'cast_dry_run':
        return this.orchestration.castDryRun(args as unknown as CastDryRunRequest)
      default:
        throw new Error(`未知工具：${name}`)
    }
  }

  private async resolveReadOnlyQuery(
    history: AgentMessage[]
  ): Promise<GroundedReadResult | null> {
    const domain = inferReadOnlyDomain(history)
    if (!domain) {
      return null
    }

    if (domain === 'tasks') {
      const result = this.toolListTasks()
      return {
        toolName: 'list_tasks',
        args: {},
        result,
        reply: renderTaskListResult(result)
      }
    }
    if (domain === 'connections') {
      const result = await this.toolListConnections()
      return {
        toolName: 'list_connections',
        args: {},
        result,
        reply: renderConnectionListResult(result)
      }
    }
    if (domain === 'templates') {
      const result = this.toolListTemplates()
      return {
        toolName: 'list_templates',
        args: {},
        result,
        reply: renderTemplateListResult(result)
      }
    }
    const result = this.toolListLLMConfigs()
    return {
      toolName: 'list_llm_configs',
      args: {},
      result,
      reply: renderLlmConfigListResult(result)
    }
  }

  private async toolListConnections() {
    const connections = await this.connections.list()
    return {
      count: connections.length,
      connections: connections.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        host: c.host,
        port: c.port,
        database: c.database,
        defaultIndex: c.defaultIndex
      }))
    }
  }

  private async toolGetConnection(id: string) {
    if (!id) throw new Error('缺少参数：id')
    const c = await this.connections.get(id)
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      host: c.host,
      port: c.port,
      username: c.username,
      database: c.database,
      defaultIndex: c.defaultIndex,
      ssl: c.ssl
    }
  }

  private toolListTemplates() {
    const templates = this.templates.list()
    return {
      count: templates.length,
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        engine: t.engine,
        action: t.action,
        connectionName: t.connectionName,
        dstConnectionName: t.dstConnectionName,
        description: t.description,
        variables: t.variables.map((v) => v.name)
      }))
    }
  }

  private async toolExecuteTemplate(id: string, vars?: Record<string, string>) {
    if (!id) throw new Error('缺少参数：id')
    const tmpl = this.templates.get(id)
    const descriptors = buildStepDescriptors(tmpl, vars ?? {})

    const taskIds: string[] = []
    for (const step of descriptors) {
      const srcConnection = await this.connections.getByName(step.connectionName)
      if (!srcConnection) {
        throw new Error(`源连接不存在：${step.connectionName}`)
      }
      let dstConnectionId: string | undefined
      if (step.dstConnectionName) {
        const dst = await this.connections.getByName(step.dstConnectionName)
        if (!dst) {
          throw new Error(`目标连接不存在：${step.dstConnectionName}`)
        }
        dstConnectionId = dst.id
      }

      const taskInput = resolveTaskInput({
        engine: step.engine,
        action: step.action,
        connectionId: srcConnection.id,
        dstConnectionId,
        configJson: step.configJson,
        vars: step.vars
      })
      const task = this.taskManager.create(taskInput)
      taskIds.push(task.id)
    }

    const firstTask = this.taskManager.get(taskIds[0]!)
    return {
      taskId: firstTask.id,
      taskIds,
      status: firstTask.status
    }
  }

  private toolListTasks() {
    const tasks = this.taskManager.list()
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const todayStartMs = todayStart.getTime()
    const todayTasks = tasks.filter((task) => {
      const createdAt = Date.parse(task.createdAt)
      return Number.isFinite(createdAt) && createdAt >= todayStartMs
    })
    const startedToday = tasks.filter((task) => {
      if (!task.startedAt) return false
      const startedAt = Date.parse(task.startedAt)
      return Number.isFinite(startedAt) && startedAt >= todayStartMs
    })
    return {
      count: tasks.length,
      todayCount: todayTasks.length,
      todayStartedCount: startedToday.length,
      todayStart: todayStart.toISOString(),
      tasks: tasks.slice(0, 20).map((t) => ({
        id: t.id,
        type: t.type,
        status: t.status,
        progress: t.progress,
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt,
        templateName: t.template?.templateName,
        error: t.error
      }))
    }
  }

  private toolGetTask(id: string) {
    if (!id) throw new Error('缺少参数：id')
    const t = this.taskManager.get(id)
    return {
      id: t.id,
      type: t.type,
      status: t.status,
      progress: t.progress,
      cursor: t.cursor,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      error: t.error
    }
  }

  private toolCancelTask(id: string) {
    if (!id) throw new Error('缺少参数：id')
    const t = this.taskManager.cancel(id)
    return { id: t.id, status: t.status }
  }

  private async toolRunPostgresExport(args: Record<string, unknown>) {
    const connectionId = stringArg(args, 'connectionId')
    const table = args['table'] as { schema?: string; name?: string } | undefined
    const outputFile = stringArg(args, 'outputFile')
    if (!connectionId) throw new Error('缺少参数：connectionId')
    if (!table?.schema || !table.name) throw new Error('缺少参数：table.schema / table.name')
    if (!outputFile) throw new Error('缺少参数：outputFile')
    const connection = await this.connections.get(connectionId)
    const task = this.taskManager.create({
      type: 'postgres-export',
      payload: {
        connectionId,
        table: { schema: table.schema, name: table.name },
        outputFile,
        batchSize: 1000
      }
    })
    return {
      taskId: task.id,
      status: task.status,
      connection: connection.name,
      table: `${table.schema}.${table.name}`,
      outputFile
    }
  }

  private async toolRunPostgresImport(args: Record<string, unknown>) {
    const connectionId = stringArg(args, 'connectionId')
    const table = args['table'] as { schema?: string; name?: string } | undefined
    const inputFile = stringArg(args, 'inputFile')
    if (!connectionId || !table?.schema || !table.name || !inputFile) {
      throw new Error('缺少必要参数：connectionId / table / inputFile')
    }
    const connection = await this.connections.get(connectionId)
    const task = this.taskManager.create({
      type: 'postgres-import',
      payload: {
        connectionId,
        table: { schema: table.schema, name: table.name },
        inputFile,
        batchSize: 1000,
        onConflict: 'skip'
      }
    })
    return {
      taskId: task.id,
      status: task.status,
      connection: connection.name,
      table: `${table.schema}.${table.name}`,
      inputFile
    }
  }

  private async toolRunElasticsearchExport(args: Record<string, unknown>) {
    const connectionId = stringArg(args, 'connectionId')
    const index = stringArg(args, 'index')
    const outputFile = stringArg(args, 'outputFile')
    if (!connectionId || !index || !outputFile) {
      throw new Error('缺少必要参数：connectionId / index / outputFile')
    }
    const connection = await this.connections.get(connectionId)
    const task = this.taskManager.create({
      type: 'elasticsearch-export',
      payload: {
        connectionId,
        index,
        outputFile,
        batchSize: 1000,
        strategy: 'search_after'
      }
    })
    return {
      taskId: task.id,
      status: task.status,
      connection: connection.name,
      index,
      outputFile
    }
  }

  private async toolRunElasticsearchImport(args: Record<string, unknown>) {
    const connectionId = stringArg(args, 'connectionId')
    const index = stringArg(args, 'index')
    const inputFile = stringArg(args, 'inputFile')
    if (!connectionId || !index || !inputFile) {
      throw new Error('缺少必要参数：connectionId / index / inputFile')
    }
    const connection = await this.connections.get(connectionId)
    const task = this.taskManager.create({
      type: 'elasticsearch-import',
      payload: {
        connectionId,
        index,
        inputFile,
        batchSize: 1000,
        onConflict: 'overwrite'
      }
    })
    return {
      taskId: task.id,
      status: task.status,
      connection: connection.name,
      index,
      inputFile
    }
  }

  private toolListLLMConfigs() {
    const configs = this.llmStore.list()
    return {
      count: configs.length,
      configs: configs.map((c) => ({
        id: c.id,
        name: c.name,
        provider: c.provider,
        model: c.model,
        enabled: c.enabled
      }))
    }
  }

  // ============ 工具 Schema ============

  private buildToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'list_connections',
        description: '列出所有已配置的数据源连接（PostgreSQL / Elasticsearch）',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'get_connection',
        description: '按 ID 获取连接详情',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: '连接 ID' } },
          required: ['id']
        }
      },
      {
        name: 'list_templates',
        description: '列出已保存的迁移模板',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'execute_template',
        description: '按模板 ID 执行迁移任务，可传入变量覆盖',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '模板 ID' },
            vars: { type: 'object', description: '模板变量键值对（可选）' }
          },
          required: ['id']
        }
      },
      {
        name: 'list_tasks',
        description: '列出最近的迁移任务（最多 20 条）',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'get_task',
        description: '按 ID 查询任务详情与进度',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: '任务 ID' } },
          required: ['id']
        }
      },
      {
        name: 'cancel_task',
        description: '取消正在运行的任务',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: '任务 ID' } },
          required: ['id']
        }
      },
      {
        name: 'run_postgres_export',
        description: '发起 PostgreSQL 表导出任务',
        parameters: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: '源 PostgreSQL 连接 ID' },
            table: {
              type: 'object',
              description: '表引用 {schema, name}'
            },
            outputFile: { type: 'string', description: '导出文件路径（jsonl）' }
          },
          required: ['connectionId', 'table', 'outputFile']
        }
      },
      {
        name: 'run_postgres_import',
        description: '发起 PostgreSQL 表导入任务',
        parameters: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: '目标 PostgreSQL 连接 ID' },
            table: { type: 'object', description: '表引用 {schema, name}' },
            inputFile: { type: 'string', description: '导入文件路径（jsonl）' }
          },
          required: ['connectionId', 'table', 'inputFile']
        }
      },
      {
        name: 'run_elasticsearch_export',
        description: '发起 Elasticsearch 索引导出任务',
        parameters: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: '源 ES 连接 ID' },
            index: { type: 'string', description: '索引名' },
            outputFile: { type: 'string', description: '导出文件路径（jsonl）' }
          },
          required: ['connectionId', 'index', 'outputFile']
        }
      },
      {
        name: 'run_elasticsearch_import',
        description: '发起 Elasticsearch 索引导入任务',
        parameters: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: '目标 ES 连接 ID' },
            index: { type: 'string', description: '目标索引名' },
            inputFile: { type: 'string', description: '导入文件路径（jsonl）' }
          },
          required: ['connectionId', 'index', 'inputFile']
        }
      },
      {
        name: 'export_preview',
        description: '无副作用预览源端前 N 行，用于推断字段和类型',
        parameters: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              enum: ['postgresql', 'mysql', 'elasticsearch', 'hive', 'sqlite']
            },
            connectionId: { type: 'string' },
            limit: { type: 'number' },
            table: { type: 'object' },
            index: { type: 'string' }
          },
          required: ['source', 'connectionId', 'limit']
        }
      },
      {
        name: 'import_validate',
        description: '校验目标表/索引和列是否存在，不写入数据',
        parameters: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              enum: ['postgresql', 'mysql', 'elasticsearch', 'hive']
            },
            connectionId: { type: 'string' },
            columns: { type: 'array' },
            table: { type: 'object' },
            index: { type: 'string' }
          },
          required: ['target', 'connectionId', 'columns']
        }
      },
      {
        name: 'cast_dry_run',
        description: '对一行样例执行 fieldTransforms 并返回结果',
        parameters: {
          type: 'object',
          properties: {
            row: { type: 'object' },
            transforms: {
              type: 'array',
              description:
                '字段转换规则数组。每项必须包含 sourceColumn、sourceType、targetType、strategy；cast 策略必须提供类型。例如 active int -> boolean。',
              items: {
                type: 'object',
                properties: {
                  sourceColumn: { type: 'string' },
                  sourceType: { type: 'string' },
                  targetColumn: { type: 'string' },
                  targetType: { type: 'string' },
                  strategy: {
                    type: 'string',
                    enum: ['json', 'cast', 'stringify', 'skip']
                  },
                  options: { type: 'object' }
                },
                required: ['sourceColumn', 'sourceType', 'targetType', 'strategy']
              }
            },
            targetTypes: { type: 'object' }
          },
          required: ['row', 'transforms']
        }
      },
      {
        name: 'list_llm_configs',
        description: '列出 LLM 配置（用于切换当前会话的 LLM）',
        parameters: { type: 'object', properties: {} }
      }
    ]
  }

  // ============ 系统提示（参考 AIIP _build_system_prompt） ============

  private buildSystemPrompt(): string {
    const now = new Date()
    const isoDate = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('-')
    const zhDate = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`

    return `你是「DataMigrator 智能体」—— 数据迁移工具的内置 AI 助手，专门帮用户操作本工具的迁移引擎。

【当前日期】${zhDate}（${isoDate}）。所有相对时间表达（如"最近""今天"）以此为锚点。

【你能做什么】
- 查询已配置的 PostgreSQL / Elasticsearch 连接（list_connections / get_connection）
- 查看与执行迁移模板（list_templates / execute_template）
- 提交新的 PostgreSQL / Elasticsearch 导出或导入任务（run_*）
- 查询任务进度、取消任务（list_tasks / get_task / cancel_task）
- 列出当前 LLM 配置以便切换（list_llm_configs）

【行为准则】
1. 用户要求执行迁移前，**先确认参数**：连接 ID（或名称）、表/索引、文件路径。模糊时主动用工具查询（list_connections / list_templates）。
2. 任务提交后返回 taskId，用户可凭此查询进度。
3. 出现错误时，给出可读的诊断信息（包含原始 error message），不要返回堆栈。
4. 输出尽量简洁，使用 Markdown 列表或表格组织结果。
5. 涉及写操作（导入、执行模板、取消任务）时，先用一句话复述用户意图，再调用工具。

【重要约束】
- 工具调用失败时不要重试超过 1 次，直接把错误反馈给用户。
- 任何涉及当前连接、模板、任务或 LLM 配置的数量、状态、最近记录和“今天/最近”问题，都必须以工具结果为准；没有工具结果时不要猜测。
- 用户纠正你时，必须重新调用工具核实，不能顺着用户的话修改答案。
- 不要捏造连接 ID / 模板 ID / 任务 ID；答复中只能引用工具结果里真实存在的 ID。`
  }
}

// ============ Helpers ============

type ReadOnlyDomain = 'tasks' | 'connections' | 'templates' | 'llm'

interface GroundedReadResult {
  toolName: string
  args: Record<string, unknown>
  result: unknown
  reply: string
}

interface TaskListToolResult {
  count: number
  todayCount: number
  todayStartedCount: number
  todayStart: string
  tasks: Array<{
    id: string
    type: string
    status: string
    progress: number
    createdAt: string
    startedAt?: string
    finishedAt?: string
    templateName?: string
    error?: string
  }>
}

interface ConnectionListToolResult {
  count: number
  connections: Array<{
    id: string
    name: string
    type: string
    host: string
    port: number
    database?: string
    defaultIndex?: string
  }>
}

interface TemplateListToolResult {
  count: number
  templates: Array<{
    id: string
    name: string
    engine: string
    action: string
    connectionName: string
    dstConnectionName?: string
    description?: string
    variables: string[]
  }>
}

interface LlmConfigListToolResult {
  count: number
  configs: Array<{
    id: string
    name: string
    provider: string
    model: string
    enabled: boolean
  }>
}

function inferReadOnlyDomain(history: AgentMessage[]): ReadOnlyDomain | null {
  const latestUser = [...history].reverse().find((message) => message.role === 'user')
  const text = latestUser?.content?.trim() ?? ''
  if (!text) {
    return null
  }

  const directDomain = inferDomain(text)
  if (directDomain) {
    const hasFactMarker =
      /(多少|几个|几条|哪些|状态|进度|结果|有没有|最近|今天|当前|列出|列表|查看|查询|查一下|看看|详情|信息|概览)/.test(
        text
      )
    const hasOperationalIntent =
      /(执行|运行|发起|创建|新建|下发|重试|取消|停止|删除|修改|更新|设置|导入|导出|测试|启动)/.test(
        text
      )
    const asksAboutPastAction =
      /(执行|下发|创建|发起|运行|导出|导入).{0,6}(多少|几个|几条|哪些|状态|进度|结果)/.test(
        text
      )
    if (hasFactMarker && (!hasOperationalIntent || asksAboutPastAction)) {
      return directDomain
    }
  }

  if (!/(有的|有啊|不是|不对|错了|明明|重新查|再查|核实|怎么回事)/.test(text)) {
    return null
  }

  const recentMessages = history.slice(-8)
  for (let index = recentMessages.length - 2; index >= 0; index -= 1) {
    const context = recentMessages[index]?.content ?? ''
    const contextDomain = inferDomain(context)
    if (contextDomain) {
      return contextDomain
    }
  }
  return null
}

function inferDomain(text: string): ReadOnlyDomain | null {
  if (/模板/.test(text)) return 'templates'
  if (/(任务|迁移记录)/.test(text)) return 'tasks'
  if (/(连接|数据源)/.test(text)) return 'connections'
  if (/(llm|大模型|模型配置)/i.test(text)) return 'llm'
  return null
}

function renderTaskListResult(result: TaskListToolResult): string {
  const lines = [
    `主进程实时查询任务库：当前共 ${result.count} 个任务；今天创建/下发 ${result.todayCount} 个，今天已开始执行 ${result.todayStartedCount} 个。`
  ]
  if (result.tasks.length === 0) {
    lines.push('', '最近没有迁移任务。')
    return lines.join('\n')
  }

  lines.push('', '最近任务（最多显示 10 条）：')
  for (const task of result.tasks.slice(0, 10)) {
    const label = task.templateName
      ? `${humanizeTaskType(task.type)} · 模板「${task.templateName}」`
      : humanizeTaskType(task.type)
    const details = [
      label,
      humanizeTaskStatus(task.status),
      `创建于 ${formatLocalDateTime(task.createdAt)}`
    ]
    if (task.error) {
      details.push(`错误：${truncate(task.error, 100)}`)
    }
    lines.push(`- \`${task.id}\` · ${details.join(' · ')}`)
  }
  if (result.tasks.length > 10) {
    lines.push('', `仅列出最近 10 条，另有 ${result.tasks.length - 10} 条可在“任务”页面查看。`)
  }
  return lines.join('\n')
}

function renderConnectionListResult(result: ConnectionListToolResult): string {
  const lines = [`主进程实时查询连接配置：当前共有 ${result.count} 个连接。`]
  if (result.connections.length === 0) {
    return `${lines[0]}\n\n当前没有已配置的连接。`
  }
  lines.push('')
  for (const connection of result.connections) {
    const endpoint =
      connection.type === 'sqlite'
        ? connection.database ?? ''
        : `${connection.host}:${connection.port}`
    const target = connection.defaultIndex ?? connection.database
    lines.push(
      `- \`${connection.id}\` · ${connection.name} · ${connection.type} · ${endpoint}${
        target ? ` · ${target}` : ''
      }`
    )
  }
  return lines.join('\n')
}

function renderTemplateListResult(result: TemplateListToolResult): string {
  const lines = [`主进程实时查询模板库：当前共有 ${result.count} 个迁移模板。`]
  if (result.templates.length === 0) {
    return `${lines[0]}\n\n当前没有已保存的迁移模板。`
  }
  lines.push('')
  for (const template of result.templates) {
    const target = template.dstConnectionName
      ? `${template.connectionName} -> ${template.dstConnectionName}`
      : template.connectionName
    lines.push(
      `- \`${template.id}\` · ${template.name} · ${template.action} · ${target} · ${template.engine}`
    )
  }
  return lines.join('\n')
}

function renderLlmConfigListResult(result: LlmConfigListToolResult): string {
  const lines = [`主进程实时查询 LLM 配置：当前共有 ${result.count} 条配置。`]
  if (result.configs.length === 0) {
    return `${lines[0]}\n\n当前没有已保存的 LLM 配置。`
  }
  lines.push('')
  for (const config of result.configs) {
    lines.push(
      `- \`${config.id}\` · ${config.name} · ${config.provider} · ${config.model} · ${
        config.enabled ? '已启用' : '未启用'
      }`
    )
  }
  return lines.join('\n')
}

function humanizeTaskType(type: string): string {
  return type
    .replace('-export-batch', ' 批量导出')
    .replace('-export', ' 导出')
    .replace('-import', ' 导入')
}

function humanizeTaskStatus(status: string): string {
  const labels: Record<string, string> = {
    created: '待开始',
    queued: '排队中',
    running: '运行中',
    paused: '已暂停',
    completed: '已完成',
    failed: '失败',
    canceled: '已取消'
  }
  return labels[status] ?? status
}

function formatLocalDateTime(value: string | undefined): string {
  if (!value) return '未知时间'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
}

function defaultBase(provider: 'ollama' | 'anthropic' | 'openai'): string {
  if (provider === 'ollama') return 'http://localhost:11434'
  if (provider === 'openai') return 'https://api.openai.com'
  return 'https://api.anthropic.com'
}

function safeParseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`参数 ${key} 必须是非空字符串`)
  }
  return value
}

function parseAnthropicResponse(data: Record<string, unknown>): {
  message: {
    content: string | null
    toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>
  }
  usage?: AgentChatResponse['usage']
} {
  const content = Array.isArray(data['content']) ? data['content'] : []
  let text = ''
  const toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> = []
  for (const block of content as Array<Record<string, unknown>>) {
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      text += block['text']
    } else if (block['type'] === 'tool_use') {
      toolCalls.push({
        id: String(block['id'] ?? randomUUID()),
        function: {
          name: String(block['name'] ?? ''),
          arguments:
            typeof block['input'] === 'string'
              ? block['input']
              : JSON.stringify(block['input'] ?? {})
        }
      })
    }
  }
  const usageRaw = data['usage'] as Record<string, number> | undefined
  return {
    message: { content: text || null, toolCalls },
    usage: usageRaw
      ? {
          promptTokens: usageRaw['input_tokens'] ?? 0,
          completionTokens: usageRaw['output_tokens'] ?? 0,
          totalTokens:
            (usageRaw['input_tokens'] ?? 0) + (usageRaw['output_tokens'] ?? 0)
        }
      : undefined
  }
}

export function parseOpenAILikeResponse(data: Record<string, unknown>): {
  message: {
    content: string | null
    toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>
  }
  usage?: AgentChatResponse['usage']
} {
  const choice = ((data['choices'] as unknown[]) ?? [])[0] as
    | Record<string, unknown>
    | undefined
  // Ollama returns `{message: {...}}`; OpenAI-compatible APIs return
  // `{choices: [{message: {...}}]}`. Accept both response shapes.
  const message =
    (data['message'] as Record<string, unknown> | undefined) ??
    (choice?.['message'] as Record<string, unknown> | undefined) ??
    {}
  const toolCallsRaw = (message['tool_calls'] as unknown[]) ?? []
  const toolCalls = toolCallsRaw.map((tc) => {
    const toolCall = tc as Record<string, unknown>
    const fn = (toolCall['function'] as Record<string, unknown>) ?? {}
    return {
      id: String(toolCall['id'] ?? randomUUID()),
      function: {
        name: String(fn['name'] ?? ''),
        arguments: typeof fn['arguments'] === 'string' ? fn['arguments'] : JSON.stringify(fn['arguments'] ?? {})
      }
    }
  })
  const content = typeof message['content'] === 'string' ? message['content'] : null
  const usageRaw = data['usage'] as Record<string, number> | undefined
  const promptTokens =
    usageRaw?.['prompt_tokens'] ??
    (typeof data['prompt_eval_count'] === 'number' ? data['prompt_eval_count'] : 0)
  const completionTokens =
    usageRaw?.['completion_tokens'] ??
    (typeof data['eval_count'] === 'number' ? data['eval_count'] : 0)
  return {
    message: { content, toolCalls },
    usage: usageRaw || promptTokens > 0 || completionTokens > 0
      ? {
          promptTokens,
          completionTokens,
          totalTokens: usageRaw?.['total_tokens'] ?? promptTokens + completionTokens
        }
      : undefined
  }
}

function toOpenAITool(tool: ToolDefinition) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }
}

function toAnthropicTool(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  }
}

function toOllamaTool(tool: ToolDefinition) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }
}

function serializeMessageForOpenAI(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'assistant' && message.tool_calls) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.tool_calls
    }
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.tool_call_id,
      content: message.content
    }
  }
  return { role: message.role, content: message.content }
}

function serializeMessageForAnthropic(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'user') {
    return { role: 'user', content: message.content }
  }
  if (message.role === 'assistant') {
    const blocks: Array<Record<string, unknown>> = []
    if (message.content) {
      blocks.push({ type: 'text', text: message.content })
    }
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeParseJson(tc.function.arguments)
        })
      }
    }
    return { role: 'assistant', content: blocks }
  }
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          content: message.content
        }
      ]
    }
  }
  // system 已单独处理，这里不会到
  return { role: 'user', content: message.content }
}

export function serializeMessageForOllama(
  message: ChatMessage
): Record<string, unknown> {
  if (message.role === 'assistant' && message.tool_calls) {
    return {
      role: 'assistant',
      content: message.content ?? '',
      tool_calls: message.tool_calls.map((toolCall) => ({
        function: {
          name: toolCall.function.name,
          arguments: safeParseJson(toolCall.function.arguments)
        }
      }))
    }
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content
    }
  }
  return { role: message.role, content: message.content }
}

function messageToChatMessage(message: AgentMessage): ChatMessage[] {
  if (message.role === 'user' || message.role === 'system') {
    return [{ role: message.role, content: message.content ?? '' }]
  }
  if (message.role === 'assistant') {
    if (message.toolArgs) {
      try {
        const parsed = JSON.parse(message.toolArgs) as Array<{
          id: string
          name: string
          arguments: string
        }>
        return [
          {
            role: 'assistant',
            content: message.content,
            tool_calls: parsed.map((p) => ({
              id: p.id,
              type: 'function' as const,
              function: { name: p.name, arguments: p.arguments }
            }))
          }
        ]
      } catch {
        return [{ role: 'assistant', content: message.content ?? '' }]
      }
    }
    return [{ role: 'assistant', content: message.content ?? '' }]
  }
  if (message.role === 'tool' && message.toolCallId) {
    return [
      {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content ?? message.toolResult ?? ''
      }
    ]
  }
  return []
}

// LLMConfig type re-export for callers (without runtime import)
export type { LLMConfig }
export type { AgentRole }

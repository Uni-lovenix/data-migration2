import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

interface ApiServerOptions {
  port: number
  tokens: Array<string | { token: string }>
  onMigrate?: (body: unknown) => Promise<unknown>
  onTasks?: () => Promise<unknown>
  onLLMChat?: (body: unknown) => Promise<unknown>
  onAgentChat?: (body: unknown) => Promise<unknown>
  onConnectionsList?: () => Promise<unknown>
  onConnectionsGet?: (id: string) => Promise<unknown>
  onTemplatesList?: () => Promise<unknown>
  onTemplateExecute?: (id: string, vars: Record<string, string> | undefined) => Promise<unknown>
  onTaskGet?: (id: string) => Promise<unknown>
  onTaskCancel?: (id: string) => Promise<unknown>
  onTaskCreate?: (input: unknown) => Promise<unknown>
}

export class ApiServer {
  private server: ReturnType<typeof createServer> | null = null
  private readonly port: number
  private readonly validTokens: Set<string>
  private readonly onMigrate?: (body: unknown) => Promise<unknown>
  private readonly onTasks?: () => Promise<unknown>
  private readonly onLLMChat?: (body: unknown) => Promise<unknown>
  private readonly onAgentChat?: (body: unknown) => Promise<unknown>
  private readonly onConnectionsList?: () => Promise<unknown>
  private readonly onConnectionsGet?: (id: string) => Promise<unknown>
  private readonly onTemplatesList?: () => Promise<unknown>
  private readonly onTemplateExecute?: (id: string, vars: Record<string, string> | undefined) => Promise<unknown>
  private readonly onTaskGet?: (id: string) => Promise<unknown>
  private readonly onTaskCancel?: (id: string) => Promise<unknown>
  private readonly onTaskCreate?: (input: unknown) => Promise<unknown>

  constructor(options: ApiServerOptions) {
    this.port = options.port
    this.validTokens = new Set(
      options.tokens.map((t) => (typeof t === 'string' ? t : t.token))
    )
    this.onMigrate = options.onMigrate
    this.onTasks = options.onTasks
    this.onLLMChat = options.onLLMChat
    this.onAgentChat = options.onAgentChat
    this.onConnectionsList = options.onConnectionsList
    this.onConnectionsGet = options.onConnectionsGet
    this.onTemplatesList = options.onTemplatesList
    this.onTemplateExecute = options.onTemplateExecute
    this.onTaskGet = options.onTaskGet
    this.onTaskCancel = options.onTaskCancel
    this.onTaskCreate = options.onTaskCreate
  }

  start(): void {
    if (this.server) return
    this.server = createServer((req, res) => {
      void this.handle(req, res)
    })
    this.server.listen(this.port, () => {
      // Server started
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }

  updateTokens(tokens: Array<string | { token: string }>): void {
    this.validTokens.clear()
    for (const t of tokens) {
      this.validTokens.add(typeof t === 'string' ? t : t.token)
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 鉴权：当 validTokens 非空时，必须提供 Bearer token
    const auth = req.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (this.validTokens.size > 0 && !this.validTokens.has(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    const url = req.url ?? '/'
    const pathname = url.split('?')[0] ?? ''

    res.setHeader('Content-Type', 'application/json')

    const sendJson = (status: number, payload: unknown): void => {
      res.writeHead(status)
      res.end(JSON.stringify(payload))
    }

    const requireId = (raw: string | undefined): string | null => {
      if (typeof raw !== 'string' || raw.length === 0) return null
      return raw
    }

    try {
      // ---------- Health ----------
      if (pathname === '/api/v1/health' && req.method === 'GET') {
        sendJson(200, { status: 'ok' })
        return
      }

      // ---------- Connections ----------
      if (pathname === '/api/v1/connections' && req.method === 'GET') {
        if (!this.onConnectionsList) return sendJson(501, { error: 'Not implemented' })
        const data = await this.onConnectionsList()
        sendJson(200, data)
        return
      }

      const connectionMatch = /^\/api\/v1\/connections\/([\w-]+)$/.exec(pathname)
      if (connectionMatch && req.method === 'GET') {
        if (!this.onConnectionsGet) return sendJson(501, { error: 'Not implemented' })
        const id = requireId(connectionMatch[1])
        if (!id) return sendJson(400, { error: 'Missing connection id' })
        const data = await this.onConnectionsGet(id)
        sendJson(200, data)
        return
      }

      // ---------- Templates ----------
      if (pathname === '/api/v1/templates' && req.method === 'GET') {
        if (!this.onTemplatesList) return sendJson(501, { error: 'Not implemented' })
        const data = await this.onTemplatesList()
        sendJson(200, data)
        return
      }

      const templateExecMatch = /^\/api\/v1\/templates\/([\w-]+)\/execute$/.exec(pathname)
      if (templateExecMatch && req.method === 'POST') {
        if (!this.onTemplateExecute) return sendJson(501, { error: 'Not implemented' })
        const id = requireId(templateExecMatch[1])
        if (!id) return sendJson(400, { error: 'Missing template id' })
        const body = await readBody(req)
        const vars = isObject(body) ? (body['vars'] as Record<string, string> | undefined) : undefined
        const data = await this.onTemplateExecute(id, vars)
        sendJson(200, data)
        return
      }

      // ---------- Tasks ----------
      if (pathname === '/api/v1/tasks' && req.method === 'GET') {
        if (!this.onTasks) return sendJson(501, { error: 'Not implemented' })
        const tasks = await this.onTasks()
        sendJson(200, tasks)
        return
      }

      if (pathname === '/api/v1/tasks' && req.method === 'POST') {
        if (!this.onTaskCreate) return sendJson(501, { error: 'Not implemented' })
        const body = await readBody(req)
        const data = await this.onTaskCreate(body)
        sendJson(200, data)
        return
      }

      const taskMatch = /^\/api\/v1\/tasks\/([\w-]+)$/.exec(pathname)
      if (taskMatch && req.method === 'GET') {
        if (!this.onTaskGet) return sendJson(501, { error: 'Not implemented' })
        const id = requireId(taskMatch[1])
        if (!id) return sendJson(400, { error: 'Missing task id' })
        const data = await this.onTaskGet(id)
        sendJson(200, data)
        return
      }

      const taskCancelMatch = /^\/api\/v1\/tasks\/([\w-]+)\/cancel$/.exec(pathname)
      if (taskCancelMatch && req.method === 'POST') {
        if (!this.onTaskCancel) return sendJson(501, { error: 'Not implemented' })
        const id = requireId(taskCancelMatch[1])
        if (!id) return sendJson(400, { error: 'Missing task id' })
        const data = await this.onTaskCancel(id)
        sendJson(200, data)
        return
      }

      // ---------- Migrate (legacy) ----------
      if (pathname === '/api/v1/migrate' && req.method === 'POST') {
        if (!this.onMigrate) return sendJson(501, { error: 'Not implemented' })
        const body = await readBody(req)
        const result = await this.onMigrate(body)
        sendJson(200, result)
        return
      }

      // ---------- LLM (legacy) ----------
      if (pathname === '/api/v1/llm/chat' && req.method === 'POST') {
        if (!this.onLLMChat) return sendJson(501, { error: 'Not implemented' })
        const body = await readBody(req)
        const result = await this.onLLMChat(body)
        sendJson(200, result)
        return
      }

      // ---------- Agent Chat ----------
      if (pathname === '/api/v1/agent/chat' && req.method === 'POST') {
        if (!this.onAgentChat) return sendJson(501, { error: 'Not implemented' })
        const body = await readBody(req)
        const result = await this.onAgentChat(body)
        sendJson(200, result)
        return
      }

      sendJson(404, { error: 'Not found' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error'
      sendJson(500, { error: message })
    }
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

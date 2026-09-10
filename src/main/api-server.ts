import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import type { APIToken } from '../shared/types'

interface ApiServerOptions {
  port: number
  tokens: APIToken[]
  onMigrate?: (body: unknown) => Promise<unknown>
  onTasks?: () => Promise<unknown>
  onLLMChat?: (body: unknown) => Promise<unknown>
}

export class ApiServer {
  private server: ReturnType<typeof createServer> | null = null
  private readonly port: number
  private readonly validTokens: Set<string>
  private readonly onMigrate?: (body: unknown) => Promise<unknown>
  private readonly onTasks?: () => Promise<unknown>
  private readonly onLLMChat?: (body: unknown) => Promise<unknown>

  constructor(options: ApiServerOptions) {
    this.port = options.port
    this.validTokens = new Set(options.tokens.map((t) => t.token))
    this.onMigrate = options.onMigrate
    this.onTasks = options.onTasks
    this.onLLMChat = options.onLLMChat
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

  updateTokens(tokens: APIToken[]): void {
    this.validTokens.clear()
    for (const t of tokens) {
      this.validTokens.add(t.token)
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Skip auth check when no tokens are configured (anonymous access for development)
    const auth = req.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (this.validTokens.size > 0 && !this.validTokens.has(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    const url = req.url ?? '/'
    const pathname = url.split('?')[0]

    res.setHeader('Content-Type', 'application/json')

    try {
      if (pathname === '/api/v1/health' && req.method === 'GET') {
        res.writeHead(200)
        res.end(JSON.stringify({ status: 'ok' }))
        return
      }

      if (pathname === '/api/v1/tasks' && req.method === 'GET') {
        if (!this.onTasks) {
          res.writeHead(501)
          res.end(JSON.stringify({ error: 'Not implemented' }))
          return
        }
        const tasks = await this.onTasks()
        res.writeHead(200)
        res.end(JSON.stringify(tasks))
        return
      }

      if (pathname === '/api/v1/migrate' && req.method === 'POST') {
        if (!this.onMigrate) {
          res.writeHead(501)
          res.end(JSON.stringify({ error: 'Not implemented' }))
          return
        }
        const body = await readBody(req)
        const result = await this.onMigrate(body)
        res.writeHead(200)
        res.end(JSON.stringify(result))
        return
      }

      if (pathname === '/api/v1/llm/chat' && req.method === 'POST') {
        if (!this.onLLMChat) {
          res.writeHead(501)
          res.end(JSON.stringify({ error: 'Not implemented' }))
          return
        }
        const body = await readBody(req)
        const result = await this.onLLMChat(body)
        res.writeHead(200)
        res.end(JSON.stringify(result))
        return
      }

      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Not found' }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error'
      res.writeHead(500)
      res.end(JSON.stringify({ error: message }))
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

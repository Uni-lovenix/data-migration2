import { createReadStream, statSync, watch } from 'node:fs'
import { EventEmitter } from 'node:events'

import type { LLMConfig } from '../shared/types'

export interface LogBatch {
  lines: string[]
  timestamp: Date
}

export interface LogRouterOptions {
  logPath: string
  onBatch: (batch: LogBatch, config: LLMConfig) => Promise<void>
  configProvider: () => LLMConfig | undefined
  intervalMs?: number
}

export class LogRouter extends EventEmitter {
  private readonly logPath: string
  private readonly onBatch: (batch: LogBatch, config: LLMConfig) => Promise<void>
  private readonly configProvider: () => LLMConfig | undefined
  private readonly intervalMs: number
  private watcher: ReturnType<typeof watch> | null = null
  private position = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private pending: string[] = []

  constructor(options: LogRouterOptions) {
    super()
    this.logPath = options.logPath
    this.onBatch = options.onBatch
    this.configProvider = options.configProvider
    this.intervalMs = options.intervalMs ?? 5000
  }

  start(): void {
    if (this.watcher) return
    this.initPosition()
    this.scheduleFlush()
    this.watcher = watch(this.logPath, () => {
      this.readNew()
    })
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private initPosition(): void {
    try {
      const stat = statSync(this.logPath)
      this.position = stat.size
    } catch {
      this.position = 0
    }
  }

  private readNew(): void {
    try {
      const stream = createReadStream(this.logPath, { start: this.position })
      let leftover = ''
      stream.on('data', (chunk: string | Buffer) => {
        const text = leftover + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
        const lines = text.split('\n')
        leftover = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim()) {
            this.pending.push(line)
          }
        }
      })
      stream.on('end', () => {
        const stat = statSync(this.logPath)
        this.position = stat.size
      })
      stream.on('error', () => {
        // ignore read errors
      })
    } catch {
      // ignore
    }
  }

  private scheduleFlush(): void {
    this.timer = setInterval(async () => {
      await this.flush()
    }, this.intervalMs)
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) return
    const config = this.configProvider()
    if (!config) return

    const lines = [...this.pending]
    this.pending = []

    try {
      await this.onBatch({ lines, timestamp: new Date() }, config)
    } catch {
      // Re-queue on failure
      this.pending.unshift(...lines)
    }
  }
}

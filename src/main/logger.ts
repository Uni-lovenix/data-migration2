import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { dirname } from 'node:path'
import { finished } from 'node:stream/promises'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogFields {
  [key: string]: unknown
}

export class StructuredLogger {
  private readonly stream: WriteStream

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true })
    this.stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf8' })
  }

  debug(service: string, message: string, fields: LogFields = {}): void {
    this.write('debug', service, message, fields)
  }

  info(service: string, message: string, fields: LogFields = {}): void {
    this.write('info', service, message, fields)
  }

  warn(service: string, message: string, fields: LogFields = {}): void {
    this.write('warn', service, message, fields)
  }

  error(service: string, message: string, fields: LogFields = {}): void {
    this.write('error', service, message, fields)
  }

  async close(): Promise<void> {
    this.stream.end()
    await finished(this.stream)
  }

  private write(level: LogLevel, service: string, message: string, fields: LogFields): void {
    this.stream.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        service,
        message,
        ...fields
      })}\n`
    )
  }
}

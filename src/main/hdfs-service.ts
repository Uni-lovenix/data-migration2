import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'

import type { ConnectionConfig } from '../shared/types'

export interface HdfsConnectionTestResult {
  ok: boolean
  message?: string
  /** GETFILESTATUS 返回的目录信息（存在时）。 */
  path?: string
}

export interface HdfsEntry {
  pathSuffix: string
  type: 'FILE' | 'DIRECTORY' | string
  length: number
}

export interface HdfsWriteOptions {
  /** 目标已存在时是否覆盖（默认 false，存在则报错）。 */
  overwrite?: boolean
}

interface WebHdfsResponse {
  status: number
  body: unknown
  text: string
  location?: string
}

/**
 * 重定向回退：WebHDFS 的 307 会指向 DataNode 自己的主机名/IP，
 * 在容器端口映射、NAT 或边缘节点场景下客户端可能解析不到。
 * 一旦重定向地址不可达（DNS/连接失败），用连接的 host 重试一次（保留重定向的端口）。
 */
interface RedirectFallback {
  host: string
}

/**
 * HDFS 访问走 WebHDFS REST API（NameNode HTTP 端口，默认 9870）。
 *
 * - 认证使用 `user.name` 查询参数（simple 认证）；Kerberos 未实现。
 * - 写文件按 WebHDFS 两段式：先向 NameNode 发不带 body 的 CREATE 拿 307 重定向，
 *   再向 DataNode 地址发送 body。
 */
export class HdfsService {
  async testConnection(connection: ConnectionConfig, path?: string): Promise<HdfsConnectionTestResult> {
    try {
      const target = normalizePath(path ?? connection.basePath ?? '/')
      const result = await this.request(connection, 'GET', target, 'GETFILESTATUS')
      if (result.status >= 200 && result.status < 300) {
        return { ok: true, path: target }
      }
      return { ok: false, message: webHdfsError(result) }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }

  /** 递归创建目录（已存在也返回成功）。 */
  async mkdirs(connection: ConnectionConfig, path: string): Promise<void> {
    const result = await this.request(connection, 'PUT', path, 'MKDIRS')
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`创建 HDFS 目录失败：${webHdfsError(result)}`)
    }
  }

  async exists(connection: ConnectionConfig, path: string): Promise<boolean> {
    const result = await this.request(connection, 'GET', path, 'GETFILESTATUS')
    if (result.status === 404) {
      return false
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`读取 HDFS 路径失败：${webHdfsError(result)}`)
    }
    return true
  }

  async listStatus(connection: ConnectionConfig, path: string): Promise<HdfsEntry[]> {
    const result = await this.request(connection, 'GET', path, 'LISTSTATUS')
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`列出 HDFS 目录失败：${webHdfsError(result)}`)
    }
    const statuses = asRecord(asRecord(result.body).FileStatuses).FileStatus
    if (!Array.isArray(statuses)) {
      return []
    }
    return statuses.map((raw) => {
      const entry = asRecord(raw)
      return {
        pathSuffix: String(entry.pathSuffix ?? ''),
        type: String(entry.type ?? ''),
        length: Number(entry.length ?? 0)
      }
    })
  }

  /** 写入一个文件（整文件一次写入；分片由调用方切分）。 */
  async writeFile(
    connection: ConnectionConfig,
    path: string,
    content: string | Buffer,
    options: HdfsWriteOptions = {}
  ): Promise<void> {
    const payload = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const redirect = await this.request(
      connection,
      'PUT',
      path,
      `CREATE&overwrite=${options.overwrite === true ? 'true' : 'false'}`,
      undefined,
      // WebHDFS：CREATE 先拿 307，再带 body 请求 DataNode。
      { followRedirect: false }
    )

    if (redirect.status === 307 || redirect.status === 308) {
      if (!redirect.location) {
        throw new Error('WebHDFS CREATE 未返回重定向地址')
      }
      const upload = await sendRequest('PUT', redirect.location, payload, {
        host: connection.host.trim()
      })
      if (upload.status < 200 || upload.status >= 300) {
        throw new Error(`写入 HDFS 文件失败：${webHdfsError(upload)}`)
      }
      return
    }

    if (redirect.status === 201 || (redirect.status >= 200 && redirect.status < 300)) {
      return
    }
    throw new Error(`写入 HDFS 文件失败：${webHdfsError(redirect)}`)
  }

  async delete(connection: ConnectionConfig, path: string, recursive = true): Promise<void> {
    const result = await this.request(
      connection,
      'DELETE',
      path,
      `DELETE&recursive=${recursive ? 'true' : 'false'}`
    )
    if (result.status === 404) {
      return
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`删除 HDFS 路径失败：${webHdfsError(result)}`)
    }
  }

  /** 读取整个文件（用于校验存档分片）。 */
  async readFile(connection: ConnectionConfig, path: string): Promise<string> {
    const base = baseUrlFor(connection)
    const user = connection.username?.trim() || 'root'
    const url = new URL(
      `${base}/webhdfs/v1${encodePath(normalizePath(path))}?op=OPEN&user.name=${encodeURIComponent(user)}`
    )
    const fallback = { host: connection.host.trim() }
    const first = await sendRequest('GET', url.toString(), undefined, fallback)
    if (first.status === 307 || first.status === 308) {
      if (!first.location) {
        throw new Error('WebHDFS OPEN 未返回重定向地址')
      }
      const download = await sendRequest('GET', first.location, undefined, fallback)
      if (download.status < 200 || download.status >= 300) {
        throw new Error(`读取 HDFS 文件失败：${webHdfsError(download)}`)
      }
      return download.text
    }
    if (first.status < 200 || first.status >= 300) {
      throw new Error(`读取 HDFS 文件失败：${webHdfsError(first)}`)
    }
    return first.text
  }

  /** 以流的方式读取文件（存档分片可能很大，避免整文件进内存）。 */
  async openReadStream(connection: ConnectionConfig, path: string): Promise<Readable> {
    const base = baseUrlFor(connection)
    const user = connection.username?.trim() || 'root'
    const url = new URL(
      `${base}/webhdfs/v1${encodePath(normalizePath(path))}?op=OPEN&user.name=${encodeURIComponent(user)}`
    )
    const fallback = { host: connection.host.trim() }
    const first = await sendRequest('GET', url.toString(), undefined, fallback)
    if (first.status === 307 || first.status === 308) {
      if (!first.location) {
        throw new Error('WebHDFS OPEN 未返回重定向地址')
      }
      return openStream(first.location, fallback, path)
    }
    if (first.status < 200 || first.status >= 300) {
      throw new Error(`读取 HDFS 文件失败：${webHdfsError(first)}`)
    }
    // 少数实现会直接返回内容，此时退化为一次性读取。
    return Readable.from([Buffer.from(first.text, 'utf8')])
  }

  private async request(
    connection: ConnectionConfig,
    method: string,
    path: string,
    operation: string,
    body?: Buffer,
    options: { followRedirect?: boolean } = {}
  ): Promise<WebHdfsResponse> {
    const base = baseUrlFor(connection)
    const user = connection.username?.trim() || 'root'
    const url = new URL(
      `${base}/webhdfs/v1${encodePath(normalizePath(path))}?op=${operation}&user.name=${encodeURIComponent(user)}`
    )
    const fallback = { host: connection.host.trim() }
    const response = await sendRequest(method, url.toString(), body, fallback)
    if (options.followRedirect === false) {
      return response
    }
    if ((response.status === 307 || response.status === 308) && response.location) {
      return sendRequest(method, response.location, body, fallback)
    }
    return response
  }
}

function sendRequest(
  method: string,
  url: string,
  body?: Buffer,
  fallback?: RedirectFallback
): Promise<WebHdfsResponse> {
  return sendOnce(method, url, body).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code
    if (
      !fallback ||
      (code !== 'ENOTFOUND' && code !== 'ECONNREFUSED' && code !== 'EHOSTUNREACH')
    ) {
      throw error
    }
    const target = new URL(url)
    if (target.hostname === fallback.host) {
      throw error
    }
    target.hostname = fallback.host
    return sendOnce(method, target.toString(), body)
  })
}

/** 打开 DataNode 上的文件流；重定向地址不可达时用连接 host 重试。 */
function openStream(
  url: string,
  fallback: RedirectFallback,
  displayPath: string
): Promise<Readable> {
  return openStreamOnce(url, displayPath).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOTFOUND' && code !== 'ECONNREFUSED' && code !== 'EHOSTUNREACH') {
      throw error
    }
    const target = new URL(url)
    if (target.hostname === fallback.host) {
      throw error
    }
    target.hostname = fallback.host
    return openStreamOnce(target.toString(), displayPath)
  })
}

function openStreamOnce(url: string, displayPath: string): Promise<Readable> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'https:' ? https : http
    const request = transport.get(
      target,
      { headers: { accept: 'application/octet-stream' }, timeout: 120_000, rejectUnauthorized: false },
      (response) => {
        const status = response.statusCode ?? 0
        if (status < 200 || status >= 300) {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
          response.on('end', () => {
            reject(
              new Error(
                `读取 HDFS 文件失败（${displayPath}）：${Buffer.concat(chunks)
                  .toString('utf8')
                  .slice(0, 200)}`
              )
            )
          })
          return
        }
        resolve(response)
      }
    )
    request.on('timeout', () => request.destroy(new Error('WebHDFS 读取超时')))
    request.on('error', reject)
  })
}

function sendOnce(method: string, url: string, body?: Buffer): Promise<WebHdfsResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'https:' ? https : http
    const headers: Record<string, string> = { accept: 'application/json' }
    if (body !== undefined) {
      headers['content-length'] = String(body.byteLength)
      headers['content-type'] = 'application/octet-stream'
    }
    const request = transport.request(
      target,
      { method, headers, timeout: 120_000, rejectUnauthorized: false },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown
          try {
            parsed = text.length === 0 ? undefined : JSON.parse(text)
          } catch {
            parsed = undefined
          }
          resolve({
            status: response.statusCode ?? 0,
            body: parsed,
            text,
            ...(typeof response.headers.location === 'string'
              ? { location: response.headers.location }
              : {})
          })
        })
      }
    )
    request.on('timeout', () => request.destroy(new Error('WebHDFS 请求超时')))
    request.on('error', reject)
    if (body !== undefined) {
      request.write(body)
    }
    request.end()
  })
}

function baseUrlFor(connection: ConnectionConfig): string {
  const host = connection.host.trim()
  if (/^https?:\/\//i.test(host)) {
    const url = new URL(host)
    if (!url.port && connection.port > 0) {
      url.port = String(connection.port)
    }
    return url.toString().replace(/\/$/, '')
  }
  return `${connection.ssl ? 'https' : 'http'}://${host}:${connection.port}`
}

function normalizePath(path: string): string {
  const trimmed = path.trim()
  if (trimmed.length === 0) {
    return '/'
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function webHdfsError(result: WebHdfsResponse): string {
  const remote = asRecord(asRecord(result.body).RemoteException)
  if (typeof remote.message === 'string') {
    return remote.message
  }
  return result.text.trim().slice(0, 300) || `HTTP ${result.status}`
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'HDFS 操作失败'
}

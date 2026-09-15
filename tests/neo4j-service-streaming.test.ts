import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { Neo4jService } from '../src/main/neo4j-service'
import { TaskCancelledError } from '../src/main/task-errors'
import type { ConnectionConfig, Neo4jExportRequest } from '../src/shared/types'

/**
 * Neo4j Source Connector 的**流式原子**契约：分页（`SKIP $offset LIMIT $batch` 循环）
 * 与 `.part` 续传协议。
 *
 * 为什么单独成文件：`tests/neo4j-service.test.ts` 是 step--2 的冻结契约
 * （`batchSize: 100` 且行数远小于批大小），它**结构上无法**覆盖
 * 「批大小小于总行数」与「带残行的 .part 续传」两条路径。
 * 真机 Neo4j 上曾实测到静默截断（`batchSize: 2` 只导出 2/5 行），
 * 故把这两条路径钉在单测层，防止回归。
 */

/** 遵守 `$offset` / `$batch` 的 fake：固定返回集合的 double 会掩盖翻页缺陷。 */
class PagingSession {
  closed = false
  calls: Array<{ offset: number; batch: number }> = []
  error: Error | null = null
  private readonly total: number
  constructor(total: number) {
    this.total = total
  }
  async run(_cypher: string, params?: Record<string, unknown>) {
    if (this.error) {
      throw this.error
    }
    const offset = readInt(params?.['offset'])
    const batch = readInt(params?.['batch'])
    this.calls.push({ offset, batch })
    const rows: Array<Record<string, unknown>> = []
    for (let index = offset; index < Math.min(offset + batch, this.total); index += 1) {
      rows.push({ _id: index, _labels: ['Person'], properties: { idx: index } })
    }
    return {
      records: (async function* iterate(): AsyncGenerator<Record<string, unknown>> {
        for (const row of rows) {
          yield row
        }
      })()
    }
  }
  async close() {
    this.closed = true
  }
}

function readInt(value: unknown): number {
  if (typeof value === 'number') return value
  if (value !== null && typeof value === 'object' && 'low' in (value as object)) {
    return Number((value as { low: number }).low)
  }
  return Number(value ?? 0)
}

function makeService(session: PagingSession): Neo4jService {
  return new Neo4jService(() => ({
    session: () => session,
    close: () => undefined
  }))
}

const connection: ConnectionConfig = {
  id: 'conn-streaming',
  name: 'streaming-neo4j',
  type: 'neo4j',
  host: 'localhost',
  port: 7687,
  username: 'neo4j',
  password: 'test',
  database: 'neo4j',
  ssl: false,
  createdAt: '2026-09-19T00:00:00Z',
  updatedAt: '2026-09-19T00:00:00Z'
}

describe('Neo4jService 流式导出', () => {
  let workdir: string
  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'neo4j-stream-'))
  })
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  const requestIn = (name: string, batchSize: number): Neo4jExportRequest => ({
    connectionId: connection.id,
    kind: 'node',
    name: 'Person',
    outputFile: join(workdir, name),
    batchSize
  })

  describe('分页：batchSize 是页大小，不是总量上限', () => {
    it('batchSize 小于总行数时翻页直到取空，不截断', async () => {
      const session = new PagingSession(5)
      const service = makeService(session)
      const request = requestIn('paged.jsonl', 2)

      const result = await service.exportTable(connection, request)

      expect(result.rows).toBe(5)
      expect(session.calls.map((c) => c.offset)).toEqual([0, 2, 4]) // 3 页，末页取不满即停
      expect(session.calls.every((c) => c.batch === 2)).toBe(true)

      const envelope = JSON.parse((await readFile(request.outputFile, 'utf8')).trim())
      expect(envelope.rows.map((row: unknown[]) => row[0])).toEqual([0, 1, 2, 3, 4])
      expect(envelope.table).toEqual({ schema: 'Node', name: 'Person' })
    })

    it('行数恰为 batchSize 整数倍时补一次空页即停', async () => {
      const session = new PagingSession(4)
      const service = makeService(session)
      const request = requestIn('exact.jsonl', 2)

      const result = await service.exportTable(connection, request)

      expect(result.rows).toBe(4)
      expect(session.calls.map((c) => c.offset)).toEqual([0, 2, 4])
    })

    it('batchSize 大于总行数时只跑一页', async () => {
      const session = new PagingSession(3)
      const service = makeService(session)
      const request = requestIn('single.jsonl', 100)

      const result = await service.exportTable(connection, request)

      expect(result.rows).toBe(3)
      expect(session.calls).toHaveLength(1)
    })

    it('resumeRows 作为首个 offset 参与翻页', async () => {
      const session = new PagingSession(5)
      const service = makeService(session)
      const request = requestIn('resume-param.jsonl', 2)

      const result = await service.exportTable(connection, request, undefined, 3)

      expect(result.rows).toBe(5) // 3 已存在 + 2 新导出
      expect(session.calls.map((c) => c.offset)).toEqual([3, 5])
      const envelope = JSON.parse((await readFile(request.outputFile, 'utf8')).trim())
      expect(envelope.rows.map((row: unknown[]) => row[0])).toEqual([3, 4])
    })
  })

  describe('.part 续传协议（与 PG / MySQL Connector 同构）', () => {
    it('从既有 .part 的信封行数续传，并丢弃尾部残行', async () => {
      const request = requestIn('resume-part.jsonl', 2)
      const partFile = `${request.outputFile}.part`
      // 预置：1 个完整信封（2 行）+ 1 条被中断的残行
      const existingEnvelope = `{"table":{"schema":"Node","name":"Person"},"columns":["_id","_labels","properties"],"rows":[[0,["Person"],{"idx":0}],[1,["Person"],{"idx":1}]]}\n`
      await writeFile(partFile, `${existingEnvelope}{"table":{"schema":"Node"`, 'utf8')

      const session = new PagingSession(5)
      const service = makeService(session)
      const result = await service.exportTable(connection, request)

      expect(result.rows).toBe(5) // 2 已落盘 + 3 新导出（offset 从 2 起）
      expect(session.calls.map((c) => c.offset)).toEqual([2, 4])

      const file = await readFile(request.outputFile, 'utf8')
      expect(file.endsWith(']}\n')).toBe(true)
      const lines = file.trim().split('\n')
      expect(lines).toHaveLength(2) // 续传信封 + 新信封
      expect(JSON.parse(lines[0]!).rows).toHaveLength(2)
      expect(JSON.parse(lines[1]!).rows.map((row: unknown[]) => row[0])).toEqual([2, 3, 4])
      // .part 已被 rename 消费
      await expect(stat(partFile)).rejects.toThrow()
    })

    it('取消：归一化为 TaskCancelledError 且保留 .part 以便续传', async () => {
      const request = requestIn('cancel.jsonl', 2)
      const session = new PagingSession(5)
      session.error = new Error('Neo4jError: Transaction canceled')
      const service = makeService(session)

      await expect(service.exportTable(connection, request)).rejects.toBeInstanceOf(
        TaskCancelledError
      )
      await expect(stat(`${request.outputFile}.part`)).resolves.toBeTruthy()
    })

    it('非取消错误：丢弃 .part，不留下不可续传的残文件', async () => {
      const request = requestIn('failed.jsonl', 2)
      const session = new PagingSession(5)
      session.error = new Error('Neo4jError: SyntaxError')
      const service = makeService(session)

      await expect(service.exportTable(connection, request)).rejects.toThrow(/Neo4j 导出失败/)
      await expect(stat(`${request.outputFile}.part`)).rejects.toThrow()
    })
  })
})

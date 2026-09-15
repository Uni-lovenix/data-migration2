import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import neo4j from 'neo4j-driver'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Neo4jService } from '../src/main/neo4j-service'
import type { ConnectionConfig } from '../src/shared/types'

/**
 * Neo4j Source Connector 真机集成测试（默认跳过）。
 *
 * 运行方式（宿主机已启动 Neo4j 5 且 Bolt 端口可达）：
 *
 * ```bash
 * NEO4J_INTEGRATION=1 NEO4J_INTEGRATION_PORT=27687 \
 *   npx vitest run tests/neo4j.integration.test.ts
 * ```
 *
 * 覆盖：真实 Bolt 握手 / 图目录列举 / 计数 / 节点与关系导出为 PG 同构 JSONL 信封 /
 * 驱动原生 Temporal 与 Point 归一化 / `SKIP $offset` 续传的确定性与无重复。
 */
const enabled = process.env.NEO4J_INTEGRATION === '1'
const port = Number(process.env.NEO4J_INTEGRATION_PORT ?? 27687)
const directory = enabled ? await mkdtemp(join(tmpdir(), 'data-migrator-neo4j-integration-')) : ''

const connection: ConnectionConfig = {
  id: 'integration-neo4j',
  name: '集成测试 Neo4j',
  type: 'neo4j',
  host: '127.0.0.1',
  port,
  username: 'neo4j',
  password: process.env.NEO4J_INTEGRATION_PASSWORD ?? 'testpassword123',
  database: 'neo4j',
  ssl: false,
  createdAt: '2026-09-19T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z'
}

const label = `Step2IT${process.pid}`
const relType = `STEP2_REL_${process.pid}`
const NODE_COUNT = 5
const REL_COUNT = 2

const service = enabled ? new Neo4jService() : null
const seedDriver = enabled
  ? neo4j.driver(`bolt://${connection.host}:${connection.port}`, neo4j.auth.basic(connection.username!, connection.password!))
  : null

beforeAll(async () => {
  if (!seedDriver) return
  const session = seedDriver.session({ database: 'neo4j' })
  try {
    await session.run(
      `UNWIND range(1, ${NODE_COUNT}) AS i
       CREATE (n:\`${label}\` {
         idx: i,
         name: 'P' + i,
         age: 20 + i,
         score: 1.5 * i,
         at: datetime('2024-05-06T07:08:09Z'),
         loc: point({x: 1.0 * i, y: 2.0 * i})
       })`
    )
    await session.run(
      `MATCH (a:\`${label}\` {idx: 1}), (b:\`${label}\` {idx: 2})
       CREATE (a)-[r:\`${relType}\` {role: 'first'}]->(b)`
    )
    await session.run(
      `MATCH (a:\`${label}\` {idx: 2}), (b:\`${label}\` {idx: 3})
       CREATE (a)-[r:\`${relType}\` {role: 'second'}]->(b)`
    )
  } finally {
    await session.close()
  }
})

afterAll(async () => {
  if (seedDriver) {
    const session = seedDriver.session({ database: 'neo4j' })
    try {
      await session.run(`MATCH (n:\`${label}\`) DETACH DELETE n`)
    } catch {
      // 清理失败不影响断言结果
    } finally {
      await session.close()
      await seedDriver.close()
    }
  }
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe.skipIf(!enabled)('Neo4jService（真机 Neo4j 5 Bolt）', () => {
  it('testConnection 握手并返回产品族名', async () => {
    const result = await service!.testConnection(connection)
    expect(result.ok).toBe(true)
    expect(result.serverVersion).toBe('Neo4j')
  })

  it('testConnection 密码错误返回可读中文', async () => {
    const result = await service!.testConnection({ ...connection, password: 'definitely-wrong' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Neo4j')
  })

  it('listTables 返回标签与关系类型', async () => {
    const tables = await service!.listTables(connection)
    expect(tables.filter((t) => t.kind === 'node').map((t) => t.name)).toContain(label)
    expect(tables.filter((t) => t.kind === 'relationship').map((t) => t.name)).toContain(relType)
  })

  it('countNodes / countRelationships 与实际数据一致', async () => {
    expect(await service!.countNodes(connection, { connectionId: connection.id, label })).toBe(
      NODE_COUNT
    )
    expect(
      await service!.countRelationships(connection, { connectionId: connection.id, type: relType })
    ).toBe(REL_COUNT)
  })

  it('导出节点：PG 同构 JSONL 信封 + 驱动原生类型归一化', async () => {
    const outputFile = join(directory, 'nodes.jsonl')
    const progress: number[] = []
    const result = await service!.exportTable(
      connection,
      { connectionId: connection.id, kind: 'node', name: label, outputFile, batchSize: 2 },
      (rows) => progress.push(rows)
    )
    expect(result.rows).toBe(NODE_COUNT)
    expect(result.table).toEqual({ kind: 'node', name: label })
    // batchSize=2 → 多次进度回调
    expect(progress.length).toBeGreaterThanOrEqual(NODE_COUNT / 2)

    const lines = (await readFile(outputFile, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    const envelope = JSON.parse(lines[0]!)
    expect(envelope.table).toEqual({ schema: 'Node', name: label })
    expect(envelope.columns).toEqual(['_id', '_labels', 'properties'])
    expect(envelope.rows).toHaveLength(NODE_COUNT)

    const [id, labels, props] = envelope.rows[0]!
    expect(typeof id).toBe('number')
    expect(labels).toEqual([label])
    expect(typeof props.age).toBe('number')
    expect(typeof props.score).toBe('number')
    // datetime → ISO 字符串（Temporal 归一化）
    expect(props.at).toBe('2024-05-06T07:08:09Z')
    // point → {x, y, z, srid}
    expect(props.loc).toMatchObject({ x: 1, y: 2, z: null, srid: 7203 })
  })

  it('导出关系：5 列信封 + 端节点 id', async () => {
    const outputFile = join(directory, 'rels.jsonl')
    const result = await service!.exportTable(connection, {
      connectionId: connection.id,
      kind: 'relationship',
      name: relType,
      outputFile,
      batchSize: 100
    })
    expect(result.rows).toBe(REL_COUNT)

    const envelope = JSON.parse((await readFile(outputFile, 'utf8')).trim())
    expect(envelope.table).toEqual({ schema: 'Relationship', name: relType })
    expect(envelope.columns).toEqual(['_id', '_type', '_src', '_dst', 'properties'])
    expect(envelope.rows[0]![1]).toBe(relType)
    expect(typeof envelope.rows[0]![2]).toBe('number')
    expect(envelope.rows.map((r: unknown[]) => (r[4] as { role: string }).role).sort()).toEqual([
      'first',
      'second'
    ])
  })

  it('续传：SKIP $offset 按稳定顺序推进，不重不漏', async () => {
    const fullFile = join(directory, 'resume-full.jsonl')
    await service!.exportTable(connection, {
      connectionId: connection.id,
      kind: 'node',
      name: label,
      outputFile: fullFile,
      batchSize: 100
    })
    const fullIds = (JSON.parse((await readFile(fullFile, 'utf8')).trim()).rows as unknown[][]).map(
      (row) => row[0]
    )
    expect(fullIds).toHaveLength(NODE_COUNT)

    const resumeFile = join(directory, 'resume-part.jsonl')
    const result = await service!.exportTable(
      connection,
      {
        connectionId: connection.id,
        kind: 'node',
        name: label,
        outputFile: resumeFile,
        batchSize: 100
      },
      undefined,
      2
    )
    expect(result.rows).toBe(NODE_COUNT)
    const resumedIds = (
      JSON.parse((await readFile(resumeFile, 'utf8')).trim()).rows as unknown[][]
    ).map((row) => row[0])

    // 关键断言：续传导出的是全量结果的后 N-2 条（顺序确定，无重复、无遗漏）
    expect(resumedIds).toEqual(fullIds.slice(2))
    expect(new Set(resumedIds).size).toBe(resumedIds.length)
  })

  it('批量导出：每个标签一个 JSONL 文件', async () => {
    const result = await service!.exportTables(connection, {
      connectionId: connection.id,
      kind: 'node',
      tables: [label],
      outputDirectory: directory,
      batchSize: 100
    })
    expect(result.rows).toBe(NODE_COUNT)
    expect(result.tables.map((t) => t.table.name)).toEqual([label])
    const file = await readFile(join(directory, `node_${label}.jsonl`), 'utf8')
    expect(JSON.parse(file.trim()).rows).toHaveLength(NODE_COUNT)
  })
})

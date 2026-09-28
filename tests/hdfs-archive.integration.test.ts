import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  ElasticsearchService,
  NodeElasticsearchHttpClient
} from '../src/main/elasticsearch-service'
import { HdfsService } from '../src/main/hdfs-service'
import {
  archiveIndexToHdfs,
  restoreIndexFromHdfs
} from '../src/main/mirror-archive-service'
import { RISK_NOTICE_VERSION } from '../src/shared/risk-notices'
import type {
  ConnectionConfig,
  ElasticsearchMirrorArchiveRequest
} from '../src/shared/types'

const execFileAsync = promisify(execFile)
const enabled = process.env.HDFS_INTEGRATION === '1'
const esPort = Number(process.env.ELASTICSEARCH_INTEGRATION_PORT ?? 9202)
const hdfsPort = Number(process.env.HDFS_INTEGRATION_PORT ?? 9870)
const hdfsContainer = process.env.HDFS_INTEGRATION_CONTAINER ?? 'dm-hdfs-test'
const index = `dm-archive-${process.pid}`
const restoredIndex = `dm-archive-restored-${process.pid}`
const hdfsDirectory = `/data-mirrors/dm-archive-${process.pid}`

const source: ConnectionConfig = {
  id: 'archive-source',
  name: '存档源集群',
  type: 'elasticsearch',
  host: '127.0.0.1',
  port: esPort,
  ssl: false,
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z'
}

const hdfsConnection: ConnectionConfig = {
  id: 'archive-hdfs',
  name: '测试 HDFS',
  type: 'hdfs',
  host: '127.0.0.1',
  port: hdfsPort,
  username: 'root',
  basePath: '/data-mirrors',
  ssl: false,
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z'
}

let directory = ''
let esClient: NodeElasticsearchHttpClient | null = null
const elasticsearch = new ElasticsearchService()
const hdfs = new HdfsService()

function riskAck(): ElasticsearchMirrorArchiveRequest['riskAck'] {
  return {
    version: RISK_NOTICE_VERSION,
    acknowledgedAt: new Date().toISOString(),
    acknowledgedBy: 'ui'
  }
}

function archiveRequest(
  overrides: Partial<ElasticsearchMirrorArchiveRequest> = {}
): ElasticsearchMirrorArchiveRequest {
  return {
    connectionId: source.id,
    index,
    hdfsConnectionId: hdfsConnection.id,
    hdfsDirectory,
    partSize: 15,
    riskAck: riskAck(),
    ...overrides
  }
}

async function resetFixtures(): Promise<void> {
  await esClient!.request({ method: 'DELETE', path: `/${index}` }).catch(() => undefined)
  await esClient!.request({ method: 'DELETE', path: `/${restoredIndex}` }).catch(() => undefined)
  await hdfs.delete(hdfsConnection, hdfsDirectory).catch(() => undefined)
  await esClient!.request({
    method: 'PUT',
    path: `/${index}`,
    body: {
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: { properties: { name: { type: 'keyword' }, score: { type: 'integer' } } }
    }
  })
  const lines: string[] = []
  for (let i = 0; i < 40; i += 1) {
    lines.push(
      JSON.stringify({ index: { _index: index, _id: String(i) } }),
      JSON.stringify({ name: `doc-${i}`, score: i })
    )
  }
  await esClient!.request({
    method: 'POST',
    path: '/_bulk?refresh=true',
    rawBody: `${lines.join('\n')}\n`
  })
}

beforeAll(async () => {
  if (!enabled) {
    return
  }
  directory = await mkdtemp(join(tmpdir(), 'data-migrator-hdfs-archive-'))
  esClient = new NodeElasticsearchHttpClient(source)
})

afterAll(async () => {
  if (esClient) {
    await esClient.request({ method: 'DELETE', path: `/${index}` }).catch(() => undefined)
    await hdfs.delete(hdfsConnection, hdfsDirectory).catch(() => undefined)
  }
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe.skipIf(!enabled)('HDFS 镜像存档', () => {
  it('runs基本的 WebHDFS 操作（mkdirs/write/exists/list/read/delete）', async () => {
    await resetFixtures()
    const probe = `${hdfsDirectory}/probe.txt`

    const test = await hdfs.testConnection(hdfsConnection, '/')
    expect(test.ok).toBe(true)

    await hdfs.mkdirs(hdfsConnection, hdfsDirectory)
    expect(await hdfs.exists(hdfsConnection, hdfsDirectory)).toBe(true)
    expect(await hdfs.exists(hdfsConnection, `${hdfsDirectory}/missing.txt`)).toBe(false)

    await hdfs.writeFile(hdfsConnection, probe, 'hello-hdfs\n')
    expect(await hdfs.readFile(hdfsConnection, probe)).toBe('hello-hdfs\n')
    await expect(
      hdfs.writeFile(hdfsConnection, probe, 'second\n', { overwrite: false })
    ).rejects.toThrow(/写入 HDFS 文件失败/)

    const entries = await hdfs.listStatus(hdfsConnection, hdfsDirectory)
    expect(entries.map((entry) => entry.pathSuffix)).toContain('probe.txt')

    await hdfs.delete(hdfsConnection, hdfsDirectory)
    expect(await hdfs.exists(hdfsConnection, hdfsDirectory)).toBe(false)
  })

  it('archives an index into HDFS with manifest, metadata and verified parts', async () => {
    await resetFixtures()

    const result = await archiveIndexToHdfs({
      connection: source,
      hdfsConnection,
      request: archiveRequest(),
      elasticsearch,
      hdfs
    })

    expect(result.rows).toBe(40)
    expect(result.parts).toBe(3) // partSize=15 => 15 + 15 + 10
    expect(result.manifestPath).toBe(`${hdfsDirectory}/manifest.json`)

    const manifest = JSON.parse(await hdfs.readFile(hdfsConnection, result.manifestPath)) as {
      status: string
      docCount: number
      parts: Array<{ name: string; rows: number; md5: string }>
      mappingHash: string
      source: { index: string }
    }
    expect(manifest.status).toBe('complete')
    expect(manifest.docCount).toBe(40)
    expect(manifest.source.index).toBe(index)
    expect(manifest.parts.map((part) => part.rows)).toEqual([15, 15, 10])
    expect(manifest.parts.every((part) => /^[0-9a-f]{32}$/.test(part.md5))).toBe(true)

    const metadata = JSON.parse(
      await hdfs.readFile(hdfsConnection, `${hdfsDirectory}/metadata.json`)
    ) as { mappings: { properties: Record<string, { type: string }> }; settings: unknown }
    expect(metadata.mappings.properties.name?.type).toBe('keyword')

    // 分片内容可被现有 ES 导入格式消费（{_id,_source} 逐行）。
    const firstPart = await hdfs.readFile(
      hdfsConnection,
      `${hdfsDirectory}/${manifest.parts[0]!.name}`
    )
    const lines = firstPart.trim().split('\n')
    expect(lines).toHaveLength(15)
    const parsed = JSON.parse(lines[0]!) as { _id: string; _source: Record<string, unknown> }
    expect(parsed._id).toBe('0')
    expect(parsed._source.name).toBe('doc-0')

    // 用 HDFS 命令行独立核对目录结构（不经我们的 WebHDFS 客户端）。
    const listing = await execFileAsync('docker', [
      'exec',
      hdfsContainer,
      'hdfs',
      'dfs',
      '-ls',
      '-R',
      hdfsDirectory
    ])
    expect(listing.stdout).toContain('manifest.json')
    expect(listing.stdout).toContain('metadata.json')
    expect(listing.stdout).toContain('part-00001.jsonl')
  })

  it('refuses to overwrite an existing archive unless asked', async () => {
    await resetFixtures()
    await archiveIndexToHdfs({
      connection: source,
      hdfsConnection,
      request: archiveRequest(),
      elasticsearch,
      hdfs
    })

    await expect(
      archiveIndexToHdfs({
        connection: source,
        hdfsConnection,
        request: archiveRequest(),
        elasticsearch,
        hdfs
      })
    ).rejects.toThrow(/HDFS 目录已存在/)

    // 原有存档保持完整
    const manifest = JSON.parse(
      await hdfs.readFile(hdfsConnection, `${hdfsDirectory}/manifest.json`)
    ) as { status: string; docCount: number }
    expect(manifest.status).toBe('complete')
    expect(manifest.docCount).toBe(40)

    const overwritten = await archiveIndexToHdfs({
      connection: source,
      hdfsConnection,
      request: archiveRequest({ existing: 'overwrite' }),
      elasticsearch,
      hdfs
    })
    expect(overwritten.rows).toBe(40)
  })

  it('cleans up the partial archive when the source index is missing', async () => {
    await resetFixtures()
    await expect(
      archiveIndexToHdfs({
        connection: source,
        hdfsConnection,
        request: archiveRequest({ index: `${index}-missing` }),
        elasticsearch,
        hdfs
      })
    ).rejects.toThrow()

    expect(await hdfs.exists(hdfsConnection, hdfsDirectory)).toBe(false)
  })

  it('restores an archive back into an index (HDFS -> cluster closed loop)', async () => {
    await resetFixtures()
    const archived = await archiveIndexToHdfs({
      connection: source,
      hdfsConnection,
      request: archiveRequest(),
      elasticsearch,
      hdfs
    })
    expect(archived.rows).toBe(40)

    const result = await restoreIndexFromHdfs({
      hdfsConnection,
      targetConnection: source,
      request: {
        hdfsConnectionId: hdfsConnection.id,
        hdfsDirectory,
        targetConnectionId: source.id,
        targetIndex: restoredIndex,
        batchSize: 10,
        conflictPolicy: 'skip',
        rollbackOn: 'manual',
        riskAck: riskAck()
      },
      elasticsearch,
      hdfs,
      control: { taskId: 'restore-1', journalPath: join(directory, 'restore-1.undo.jsonl') }
    })

    expect(result.rows).toBe(40)
    expect(result.parts).toBe(3)
    expect(result.targetCreated).toBe(true)
    expect(result.index).toBe(restoredIndex)

    await esClient!.request({ method: 'POST', path: `/${restoredIndex}/_refresh` })
    const count = (await esClient!.request({
      method: 'POST',
      path: `/${restoredIndex}/_count`,
      body: { query: { match_all: {} } }
    })) as { body: { count: number } }
    expect(count.body.count).toBe(40)

    const mapping = (await esClient!.request({
      method: 'GET',
      path: `/${restoredIndex}/_mapping`
    })) as { body: Record<string, { mappings: { properties: Record<string, { type: string }> } }> }
    expect(mapping.body[restoredIndex]?.mappings.properties.name?.type).toBe('keyword')

    const doc = (await esClient!.request({
      method: 'GET',
      path: `/${restoredIndex}/_doc/7`
    })) as { body: { _source: Record<string, unknown> } }
    expect(doc.body._source.name).toBe('doc-7')

    // 恢复任务同样可以整体回滚（删除本次创建的索引）
    const rollback = await elasticsearch.rollbackDirectMigration(
      source,
      {
        taskId: 'restore-1',
        journalPath: join(directory, 'restore-1.undo.jsonl'),
        conflictPolicy: 'abort',
        dropCreatedTarget: true
      }
    )
    expect(rollback.deletedRows).toBe(40)
    const gone = await esClient!.request({ method: 'HEAD', path: `/${restoredIndex}` })
    expect(gone.status).toBe(404)
  })

  it('refuses to restore an incomplete archive', async () => {
    await resetFixtures()
    await archiveIndexToHdfs({
      connection: source,
      hdfsConnection,
      request: archiveRequest(),
      elasticsearch,
      hdfs
    })
    const manifestPath = `${hdfsDirectory}/manifest.json`
    const manifest = JSON.parse(await hdfs.readFile(hdfsConnection, manifestPath)) as Record<
      string,
      unknown
    >
    manifest.status = 'incomplete'
    await hdfs.writeFile(hdfsConnection, manifestPath, JSON.stringify(manifest), {
      overwrite: true
    })

    await expect(
      restoreIndexFromHdfs({
        hdfsConnection,
        targetConnection: source,
        request: {
          hdfsConnectionId: hdfsConnection.id,
          hdfsDirectory,
          targetConnectionId: source.id,
          targetIndex: restoredIndex,
          batchSize: 10,
          conflictPolicy: 'skip',
          rollbackOn: 'none',
          riskAck: riskAck()
        },
        elasticsearch,
        hdfs
      })
    ).rejects.toThrow(/存档不完整/)
  })

  it('detects a corrupted part through the manifest checksum', async () => {
    await resetFixtures()
    await archiveIndexToHdfs({
      connection: source,
      hdfsConnection,
      request: archiveRequest(),
      elasticsearch,
      hdfs
    })
    const manifest = JSON.parse(
      await hdfs.readFile(hdfsConnection, `${hdfsDirectory}/manifest.json`)
    ) as { parts: Array<{ name: string }> }
    const firstPart = manifest.parts[0]!.name
    await hdfs.writeFile(
      hdfsConnection,
      `${hdfsDirectory}/${firstPart}`,
      '{"_id":"tampered","_source":{"name":"tampered"}}\n',
      { overwrite: true }
    )

    await expect(
      restoreIndexFromHdfs({
        hdfsConnection,
        targetConnection: source,
        request: {
          hdfsConnectionId: hdfsConnection.id,
          hdfsDirectory,
          targetConnectionId: source.id,
          targetIndex: restoredIndex,
          batchSize: 10,
          conflictPolicy: 'skip',
          rollbackOn: 'manual',
          riskAck: riskAck()
        },
        elasticsearch,
        hdfs,
        control: {
          taskId: 'restore-bad',
          journalPath: join(directory, 'restore-bad.undo.jsonl')
        }
      })
    ).rejects.toThrow(/存档分片校验失败/)
  })
})

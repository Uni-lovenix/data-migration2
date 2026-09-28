import { createHash } from 'node:crypto'

import type {
  ConnectionConfig,
  ElasticsearchMirrorArchiveRequest,
  ElasticsearchMirrorArchiveResult,
  ElasticsearchReadStrategy,
  MirrorArchivePart
} from '../shared/types'
import { serializeHit } from './elasticsearch-service'
import type { HdfsService } from './hdfs-service'

export const MIRROR_ARCHIVE_FORMAT_VERSION = 1
export const MIRROR_ARCHIVE_STREAM_BATCH = 500

export interface MirrorArchiveElasticsearch {
  streamIndexBatches(
    connection: ConnectionConfig,
    options: {
      index: string
      batchSize: number
      strategy?: ElasticsearchReadStrategy
      query?: string
    },
    onBatch: (hits: unknown[]) => Promise<void>
  ): Promise<void>
  readIndexMetadata(
    connection: ConnectionConfig,
    index: string
  ): Promise<{ settings: Record<string, unknown>; mappings: unknown; aliases: unknown }>
}

export interface MirrorArchiveOptions {
  /** 源 Elasticsearch 连接。 */
  connection: ConnectionConfig
  /** 目标 HDFS 连接。 */
  hdfsConnection: ConnectionConfig
  request: ElasticsearchMirrorArchiveRequest
  elasticsearch: MirrorArchiveElasticsearch
  hdfs: Pick<HdfsService, 'exists' | 'mkdirs' | 'writeFile' | 'delete'>
  onProgress?: (rows: number, cursor?: unknown) => void
}

interface ArchiveManifest {
  formatVersion: number
  status: 'writing' | 'complete' | 'incomplete'
  source: {
    index: string
    connectionName: string
    host: string
    strategy: string
  }
  createdAt: string
  finishedAt?: string
  docCount: number
  partSize: number
  mappingHash: string
  metadataFile: string
  parts: MirrorArchivePart[]
  error?: string
}

/**
 * 把 Elasticsearch 索引镜像（metadata + 数据分片）写入 HDFS。
 *
 * 目录结构：
 *   <hdfsDirectory>/manifest.json     # 状态与完整性信息（分片 md5、文档数）
 *   <hdfsDirectory>/metadata.json     # settings / mappings / aliases
 *   <hdfsDirectory>/data/part-00001.jsonl
 *
 * HDFS 没有事务：失败（含取消）时写入 `incomplete` manifest 并按配置删除本次目录，
 * 成功则写 `complete` manifest，作为可校验的镜像存档。
 */
export async function archiveIndexToHdfs(
  options: MirrorArchiveOptions
): Promise<ElasticsearchMirrorArchiveResult> {
  const { connection, hdfsConnection, request, elasticsearch, hdfs, onProgress } = options
  const startedAt = performance.now()
  const directory = request.hdfsDirectory.replace(/\/+$/, '') || '/'
  const metadataPath = `${directory}/metadata.json`
  const manifestPath = `${directory}/manifest.json`
  const dataDirectory = `${directory}/data`
  const partSize = request.partSize ?? 20_000
  const createdAt = new Date().toISOString()

  const metadata = await elasticsearch.readIndexMetadata(connection, request.index)
  const mappingHash = md5(JSON.stringify(metadata.mappings ?? {}))

  const buildManifest = (
    status: ArchiveManifest['status'],
    rows: number,
    parts: MirrorArchivePart[],
    extra: { error?: string; finishedAt?: string } = {}
  ): ArchiveManifest => ({
    formatVersion: MIRROR_ARCHIVE_FORMAT_VERSION,
    status,
    source: {
      index: request.index,
      connectionName: connection.name,
      host: `${connection.host}:${connection.port}`,
      strategy: request.strategy ?? 'scroll'
    },
    createdAt,
    docCount: rows,
    partSize,
    mappingHash,
    metadataFile: 'metadata.json',
    parts,
    ...extra
  })

  if (await hdfs.exists(hdfsConnection, directory)) {
    if (request.existing !== 'overwrite') {
      throw new Error(
        `HDFS 目录已存在：${directory}；如需覆盖请改用「覆盖」策略`
      )
    }
    await hdfs.delete(hdfsConnection, directory, true)
  }
  await hdfs.mkdirs(hdfsConnection, dataDirectory)

  const parts: MirrorArchivePart[] = []
  let rows = 0
  let bytes = 0
  let buffer: string[] = []
  let bufferedRows = 0

  const flushPart = async (): Promise<void> => {
    if (bufferedRows === 0) {
      return
    }
    const name = `data/part-${String(parts.length + 1).padStart(5, '0')}.jsonl`
    const content = buffer.join('')
    const size = Buffer.byteLength(content)
    await hdfs.writeFile(hdfsConnection, `${directory}/${name}`, content, {
      overwrite: false
    })
    parts.push({
      name,
      rows: bufferedRows,
      bytes: size,
      md5: md5(content)
    })
    bytes += size
    buffer = []
    bufferedRows = 0
  }

  try {
    await hdfs.writeFile(
      hdfsConnection,
      metadataPath,
      JSON.stringify(
        {
          index: request.index,
          exportedAt: createdAt,
          settings: metadata.settings,
          mappings: metadata.mappings ?? {},
          aliases: metadata.aliases ?? {}
        },
        null,
        2
      ),
      { overwrite: true }
    )
    await hdfs.writeFile(
      hdfsConnection,
      manifestPath,
      JSON.stringify(buildManifest('writing', 0, []), null, 2),
      { overwrite: true }
    )

    await elasticsearch.streamIndexBatches(
      connection,
      {
        index: request.index,
        batchSize: MIRROR_ARCHIVE_STREAM_BATCH,
        ...(request.strategy ? { strategy: request.strategy } : {}),
        ...(request.query ? { query: request.query } : {})
      },
      async (hits) => {
        for (const hit of hits) {
          buffer.push(`${JSON.stringify(serializeHit(hit))}\n`)
          bufferedRows += 1
          rows += 1
          if (bufferedRows >= partSize) {
            await flushPart()
          }
        }
        onProgress?.(rows, { rows })
      }
    )
    await flushPart()

    const manifest = buildManifest('complete', rows, parts, {
      finishedAt: new Date().toISOString()
    })
    await hdfs.writeFile(hdfsConnection, manifestPath, JSON.stringify(manifest, null, 2), {
      overwrite: true
    })

    return {
      rows,
      parts: parts.length,
      bytes,
      durationMs: performance.now() - startedAt,
      index: request.index,
      hdfsDirectory: directory,
      manifestPath
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await hdfs
      .writeFile(
        hdfsConnection,
        manifestPath,
        JSON.stringify(
          buildManifest('incomplete', rows, parts, {
            error: message,
            finishedAt: new Date().toISOString()
          }),
          null,
          2
        ),
        { overwrite: true }
      )
      .catch(() => undefined)
    if (request.cleanupOnFailure !== false) {
      await hdfs.delete(hdfsConnection, directory, true).catch(() => undefined)
    }
    throw error
  }
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

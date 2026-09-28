import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'

import type {
  ConnectionConfig,
  DirectConflictPolicy,
  ElasticsearchMirrorArchiveRequest,
  ElasticsearchMirrorArchiveResult,
  ElasticsearchMirrorRestoreRequest,
  ElasticsearchMirrorRestoreResult,
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

export interface MirrorRestoreElasticsearch {
  restoreIndex(
    target: ConnectionConfig,
    options: {
      targetIndex: string
      metadata: { settings: Record<string, unknown>; mappings: unknown; aliases: unknown }
      createTargetIndex: boolean
      copyAliases?: boolean
      conflictPolicy: DirectConflictPolicy
      control?: { taskId: string; journalPath: string }
    },
    readBatches: (onBatch: (hits: unknown[]) => Promise<void>) => Promise<void>,
    onProgress?: (rows: number, cursor?: unknown) => void
  ): Promise<{
    rows: number
    skipped: number
    targetCreated: boolean
    undoJournalPath?: string
  }>
}

export interface MirrorRestoreOptions {
  hdfsConnection: ConnectionConfig
  targetConnection: ConnectionConfig
  request: ElasticsearchMirrorRestoreRequest
  elasticsearch: MirrorRestoreElasticsearch
  hdfs: Pick<HdfsService, 'readFile' | 'openReadStream'>
  /** 撤销日志（回滚用）；rollbackOn=none 时不传。 */
  control?: { taskId: string; journalPath: string }
  onProgress?: (rows: number, cursor?: unknown) => void
}

interface ArchiveMetadata {
  index: string
  settings: Record<string, unknown>
  mappings: unknown
  aliases: unknown
}

/**
 * 从 HDFS 镜像存档恢复到目标集群。
 *
 * - 必须 status=complete 的 manifest（未完成/被清理的存档直接拒绝）。
 * - 默认恢复到存档内的同名索引，可用 targetIndex 覆盖。
 * - 读分片时逐片校验 md5 与行数（verifyChecksums），写入复用直连链路，
 *   因此失败/取消同样可以按 rollbackOn 策略回滚。
 */
export async function restoreIndexFromHdfs(
  options: MirrorRestoreOptions
): Promise<ElasticsearchMirrorRestoreResult> {
  const { hdfsConnection, targetConnection, request, elasticsearch, hdfs, control, onProgress } =
    options
  const startedAt = performance.now()
  const directory = request.hdfsDirectory.replace(/\/+$/, '') || '/'
  const manifestPath = `${directory}/manifest.json`

  const manifest = JSON.parse(await hdfs.readFile(hdfsConnection, manifestPath)) as ArchiveManifest
  if (manifest.formatVersion !== MIRROR_ARCHIVE_FORMAT_VERSION) {
    throw new Error(`不支持的存档格式版本：${manifest.formatVersion}`)
  }
  if (manifest.status !== 'complete') {
    throw new Error(
      `存档不完整（status=${manifest.status}），拒绝恢复：${manifestPath}`
    )
  }

  const metadata = JSON.parse(
    await hdfs.readFile(hdfsConnection, `${directory}/${manifest.metadataFile ?? 'metadata.json'}`)
  ) as ArchiveMetadata
  const targetIndex = request.targetIndex ?? metadata.index ?? manifest.source.index
  const verify = request.verifyChecksums !== false

  const readBatches = async (
    onBatch: (hits: unknown[]) => Promise<void>
  ): Promise<void> => {
    let pending: unknown[] = []
    const flush = async (): Promise<void> => {
      if (pending.length === 0) {
        return
      }
      const batch = pending
      pending = []
      await onBatch(batch)
    }

    for (const part of manifest.parts) {
      const partPath = `${directory}/${part.name}`
      const stream = await hdfs.openReadStream(hdfsConnection, partPath)
      const hash = createHash('md5')
      let rows = 0
      const lines = createInterface({ input: stream, crlfDelay: Infinity })
      for await (const line of lines) {
        if (line.trim().length === 0) {
          continue
        }
        hash.update(`${line}\n`)
        rows += 1
        pending.push(JSON.parse(line) as unknown)
        if (pending.length >= request.batchSize) {
          await flush()
        }
      }
      await flush()
      if (verify) {
        const digest = hash.digest('hex')
        if (digest !== part.md5) {
          throw new Error(
            `存档分片校验失败：${part.name}（md5 ${digest} != ${part.md5}）`
          )
        }
        if (rows !== part.rows) {
          throw new Error(
            `存档分片行数不一致：${part.name}（${rows} != ${part.rows}）`
          )
        }
      }
    }
  }

  const result = await elasticsearch.restoreIndex(
    targetConnection,
    {
      targetIndex,
      metadata: {
        settings: metadata.settings ?? {},
        mappings: metadata.mappings ?? {},
        aliases: metadata.aliases ?? {}
      },
      createTargetIndex: request.createTargetIndex !== false,
      copyAliases: request.copyAliases === true,
      conflictPolicy: request.conflictPolicy,
      ...(control ? { control } : {})
    },
    readBatches,
    onProgress
  )

  return {
    rows: result.rows,
    skipped: result.skipped,
    parts: manifest.parts.length,
    durationMs: performance.now() - startedAt,
    index: targetIndex,
    sourceDirectory: directory,
    targetCreated: result.targetCreated,
    ...(result.undoJournalPath ? { undoJournalPath: result.undoJournalPath } : {})
  }
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

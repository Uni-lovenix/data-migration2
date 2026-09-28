import { open, mkdir, readFile, rm, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * 撤销日志（Write-Ahead Undo）。
 *
 * 直连迁移按批次提交目标端事务，但"迁移事务"是整任务。为了让整任务可回滚，
 * 每个批次提交**之前**先落盘该批次的回滚信息，提交后再补一条 commit 记录。
 * 崩溃恢复时，有 batch 记录但没有 commit 记录的批次按"可能已写入"处理，
 * 回滚过程本身是幂等的，因此两种情况都能收敛到迁移前状态。
 */
export const UNDO_JOURNAL_VERSION = 1

export interface UndoKeyEntry {
  /** 目标端 md5(ROW(主键列...)) 的十六进制串，回滚时用同一表达式匹配。 */
  keyHash: string
  /** 写入后整行 md5(行::text)；未写入（冲突跳过）时为 null。 */
  rowHash: string | null
  /** 覆盖写时被覆盖行的原值；插入行为 null。 */
  preImage: Record<string, unknown> | null
}

export type UndoJournalEngine = 'postgres' | 'elasticsearch'

/**
 * Elasticsearch 文档级撤销条目。
 *
 * 目标端没有事务，写入本身就是提交，因此无法像 PostgreSQL 那样做到严格
 * "先记日志再提交"。这里的做法是：写入前先落盘 pending 计划（含前映像），
 * 写入后追加 batch-result 记录真实结果。崩溃时 pending 且无结果的批次
 * 视为"状态未知"，回滚时按冲突处理，绝不删除无法确认来源的文档。
 */
export interface UndoDocEntry {
  id: string
  routing?: string | null
  state: 'pending' | 'written' | 'skipped'
  /** 写入后 _source 的 md5（结果记录中才有）。 */
  rowHash?: string | null
  /** 写入后的 _seq_no / _primary_term，作为回滚时的条件写守卫。 */
  seqNo?: number | null
  primaryTerm?: number | null
  preImage?: Record<string, unknown> | null
  /** 覆盖写之前文档的 _seq_no / _primary_term。 */
  preSeqNo?: number | null
  prePrimaryTerm?: number | null
}

export interface UndoBatchRecord {
  kind: 'batch'
  version: number
  taskId: string
  sequence: number
  mode: 'insert' | 'overwrite'
  target: { schema: string; name: string }
  keyFields: string[]
  keys: UndoKeyEntry[]
  capturedAt: string
  /** 缺省视为 postgres（历史记录兼容）。 */
  engine?: UndoJournalEngine
  /** Elasticsearch 的文档计划（写入前落盘）。 */
  docs?: UndoDocEntry[]
}

/** Elasticsearch 批次写入结果，写成功后追加。 */
export interface UndoBatchResultRecord {
  kind: 'batch-result'
  version: number
  taskId: string
  sequence: number
  written: number
  skipped: number
  docs: UndoDocEntry[]
  at: string
}

export interface UndoCommitRecord {
  kind: 'commit'
  version: number
  taskId: string
  sequence: number
  written: number
  skipped: number
  at: string
}

export type UndoJournalRecord =
  | UndoBatchRecord
  | UndoCommitRecord
  | UndoBatchResultRecord

export interface UndoJournalContents {
  batches: UndoBatchRecord[]
  commits: Map<number, UndoCommitRecord>
  results: Map<number, UndoBatchResultRecord>
}

export class UndoJournal {
  private readonly filePath: string
  private readonly taskId: string
  private handle: FileHandle | undefined

  constructor(filePath: string, taskId: string) {
    this.filePath = filePath
    this.taskId = taskId
  }

  get path(): string {
    return this.filePath
  }

  async open(): Promise<void> {
    if (this.handle) {
      return
    }
    await mkdir(dirname(this.filePath), { recursive: true })
    this.handle = await open(this.filePath, 'a')
  }

  /** 追加批次回滚信息并落盘（fsync），必须在目标端提交之前调用。 */
  async recordBatch(record: Omit<UndoBatchRecord, 'kind' | 'version' | 'taskId'>): Promise<void> {
    await this.append({
      kind: 'batch',
      version: UNDO_JOURNAL_VERSION,
      taskId: this.taskId,
      ...record
    })
  }

  /** 目标端批次提交成功后追加提交标记。 */
  async markCommitted(sequence: number, written: number, skipped: number): Promise<void> {
    await this.append({
      kind: 'commit',
      version: UNDO_JOURNAL_VERSION,
      taskId: this.taskId,
      sequence,
      written,
      skipped,
      at: new Date().toISOString()
    })
  }

  /** Elasticsearch：写入前落盘批次计划（含前映像），保证崩溃后可判定。 */
  async recordPendingBatch(
    record: Omit<UndoBatchRecord, 'kind' | 'version' | 'taskId'>
  ): Promise<void> {
    await this.append({
      kind: 'batch',
      version: UNDO_JOURNAL_VERSION,
      taskId: this.taskId,
      engine: 'elasticsearch',
      ...record
    })
  }

  /** Elasticsearch：bulk 成功/失败后追加真实结果，pending 批次据此判定。 */
  async recordBatchResult(record: {
    sequence: number
    written: number
    skipped: number
    docs: UndoDocEntry[]
  }): Promise<void> {
    await this.append({
      kind: 'batch-result',
      version: UNDO_JOURNAL_VERSION,
      taskId: this.taskId,
      at: new Date().toISOString(),
      ...record
    })
  }

  async close(): Promise<void> {
    const handle = this.handle
    this.handle = undefined
    if (handle) {
      await handle.close().catch(() => undefined)
    }
  }

  private async append(record: UndoJournalRecord): Promise<void> {
    if (!this.handle) {
      await this.open()
    }
    const handle = this.handle
    if (!handle) {
      throw new Error('撤销日志未打开')
    }
    await handle.write(`${JSON.stringify(record)}\n`)
    await handle.sync()
  }
}

export async function readUndoJournal(filePath: string): Promise<UndoJournalContents> {
  const content = await readFile(filePath, 'utf8')
  const batches: UndoBatchRecord[] = []
  const commits = new Map<number, UndoCommitRecord>()
  const results = new Map<number, UndoBatchResultRecord>()

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      continue
    }
    let parsed: UndoJournalRecord
    try {
      parsed = JSON.parse(trimmed) as UndoJournalRecord
    } catch {
      // 崩溃可能留下半行，忽略残行（对应批次按"可能已写入"处理）。
      continue
    }
    if (parsed.kind === 'batch') {
      batches.push(parsed)
    } else if (parsed.kind === 'commit') {
      commits.set(parsed.sequence, parsed)
    } else if (parsed.kind === 'batch-result') {
      results.set(parsed.sequence, parsed)
    }
  }

  return { batches, commits, results }
}

export async function removeUndoJournal(filePath: string): Promise<void> {
  await rm(filePath, { force: true })
}

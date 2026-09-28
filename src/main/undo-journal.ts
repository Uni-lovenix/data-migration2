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

export type UndoJournalRecord = UndoBatchRecord | UndoCommitRecord

export interface UndoJournalContents {
  batches: UndoBatchRecord[]
  commits: Map<number, UndoCommitRecord>
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
    }
  }

  return { batches, commits }
}

export async function removeUndoJournal(filePath: string): Promise<void> {
  await rm(filePath, { force: true })
}

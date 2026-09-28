import type { DirectConflictPolicy, RollbackPolicy } from './types'

/**
 * 风险文案版本号。文案内容变更后必须提升版本，历史确认记录随旧版本失效，
 * 避免用户对"已经变过的提示"继续放行新的破坏性操作。
 */
export const RISK_NOTICE_VERSION = '2026-09-28.1'

export interface RiskNoticeItem {
  /** 简短结论，放在列表项首行。 */
  label: string
  /** 具体后果说明。 */
  detail: string
}

export interface RiskNotice {
  version: string
  title: string
  summary: string
  items: RiskNoticeItem[]
}

export interface DirectRiskNoticeOptions {
  sourceLabel: string
  targetLabel: string
  conflictPolicy: DirectConflictPolicy
  rollbackOn: RollbackPolicy
  dropCreatedTarget?: boolean
}

export interface RollbackRiskNoticeOptions {
  sourceLabel: string
  targetLabel: string
  deleteRows: number
  restoreRows: number
  dropCreatedTarget?: boolean
  conflictPolicy: 'abort' | 'skip'
}

export function directMigrationRiskNotice(
  options: DirectRiskNoticeOptions
): RiskNotice {
  const items: RiskNoticeItem[] = [
    {
      label: '数据直接写入目标库',
      detail: `数据将从「${options.sourceLabel}」直接写入「${options.targetLabel}」，本地不会生成可复核的中转文件。目标端一旦开始写入，就没有"先看文件再决定"的机会。`
    },
    {
      label: '需要两端同时在线',
      detail:
        '源库与目标库必须全程可达；网络中断会中断迁移，只能按已完成批次续传或整体回滚。'
    },
    {
      label: '迁移期间目标端建议只读',
      detail:
        '迁移窗口内如果有其他程序写入同一张表，回滚时会出现冲突行，无法保证恢复到迁移前状态。'
    },
    {
      label: '影响目标库在线业务',
      detail:
        '大批量写入会占用目标库的连接、锁、WAL 与磁盘空间，可能拖慢甚至阻塞目标库上的其他业务。'
    },
    {
      label: '回滚策略',
      detail: rollbackPolicyDetail(options.rollbackOn)
    }
  ]

  if (options.conflictPolicy === 'overwrite') {
    items.push({
      label: '将覆盖目标端已有数据',
      detail:
        '冲突策略为"覆盖写入"：目标端已存在的行会被源数据覆盖，原值只在撤销日志保留期内可恢复。'
    })
  } else {
    items.push({
      label: '跳过目标端已有数据',
      detail:
        '冲突策略为"跳过已存在"：目标端已存在的行不会被修改，源端这些行的内容不会写过去。'
    })
  }

  if (options.rollbackOn !== 'none' && options.dropCreatedTarget) {
    items.push({
      label: '回滚会删除本次创建的目标表',
      detail:
        '如果目标表由本次任务自动创建，回滚时会连同该表及其中的全部数据一起删除（包括回滚前写入的其他内容）。'
    })
  }

  return {
    version: RISK_NOTICE_VERSION,
    title: '直连迁移风险确认',
    summary: `即将把「${options.sourceLabel}」的数据直接写入「${options.targetLabel}」。请确认已了解以下后果。`,
    items
  }
}

export function rollbackRiskNotice(options: RollbackRiskNoticeOptions): RiskNotice {
  const items: RiskNoticeItem[] = [
    {
      label: '回滚会删除本次迁移写入的数据',
      detail: `将从「${options.targetLabel}」删除本次任务写入的 ${options.deleteRows} 行/文档。`
    },
    {
      label: '回滚会恢复被覆盖的原值',
      detail: `会把本次任务覆盖过的 ${options.restoreRows} 行/文档恢复为迁移前的值。`
    },
    {
      label: '操作不可逆',
      detail:
        '回滚本身不能再被"回滚"。如果回滚后仍需目标端数据，只能重新执行迁移。'
    },
    {
      label: '无法恢复第三方的并发修改',
      detail: conflictPolicyDetail(options.conflictPolicy)
    }
  ]

  if (options.dropCreatedTarget) {
    items.push({
      label: '将删除本次创建的目标对象',
      detail:
        '目标表由本次迁移自动创建，回滚会删除该表及其全部数据（可能包含迁移之后写入的其他内容）。'
    })
  }

  return {
    version: RISK_NOTICE_VERSION,
    title: '回滚风险确认',
    summary: `即将回滚「${options.sourceLabel}」到「${options.targetLabel}」的本次迁移结果。请确认已了解以下后果。`,
    items
  }
}

export function riskNoticeVersion(): string {
  return RISK_NOTICE_VERSION
}

function rollbackPolicyDetail(policy: RollbackPolicy): string {
  switch (policy) {
    case 'none':
      return '本次任务不记录撤销日志：任务失败后目标端的半成品数据无法回滚，只能手工清理。'
    case 'manual':
      return '本次任务记录撤销日志，但失败或取消后不会自动回滚，需要你在任务中心手动确认执行。'
    case 'failure':
      return '任务失败时会自动回滚目标端数据（会直接删除已写入的行），取消时不自动回滚。'
    case 'failure-or-cancel':
      return '任务失败或取消时都会自动回滚目标端数据（会直接删除已写入的行），无需你再次确认。'
  }
}

function conflictPolicyDetail(policy: 'abort' | 'skip'): string {
  return policy === 'abort'
    ? '如果回滚前有行/文档被其他程序修改过，回滚会立即停止并报告冲突，剩余批次保持原样。'
    : '如果回滚前有行/文档被其他程序修改过，回滚会跳过这些行并继续，冲突数量会在结果中报告。'
}

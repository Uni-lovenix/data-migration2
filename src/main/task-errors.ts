export class TaskCancelledError extends Error {
  constructor(taskId: string) {
    super(`任务已取消：${taskId}`)
    this.name = 'TaskCancelledError'
  }
}

/** 回滚过程中检测到第三方修改，按 abort 策略中止。 */
export class RollbackConflictError extends Error {
  readonly conflicts: number

  constructor(conflicts: number, target: string) {
    super(`回滚中止：目标 ${target} 有 ${conflicts} 行/文档在迁移后被修改，无法安全回滚`)
    this.name = 'RollbackConflictError'
    this.conflicts = conflicts
  }
}

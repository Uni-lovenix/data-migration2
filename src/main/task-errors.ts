export class TaskCancelledError extends Error {
  constructor(taskId: string) {
    super(`任务已取消：${taskId}`)
    this.name = 'TaskCancelledError'
  }
}

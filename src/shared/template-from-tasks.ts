// Convert a list of executed `MigrationTask`s into a `CreateTemplateInput`
// suitable for `TemplateStore.create`.
//
// Design notes (see also docs/PROCESS.md → iteration "任务页多选生成模板"):
//   - Each task becomes exactly one template step (no implicit splitting of
//     `postgres-export-batch` — the batch payload is preserved as-is so the
//     template remains faithful to what was actually executed).
//   - Output / input file paths are rewritten to live under a single
//     `{{DATA_DIR}}` variable so all data resources land in one configurable
//     directory. The variable is added to the template-level `variables` list;
//     the user fills it in at execute time via the existing ExecuteModal.
//   - `connectionId`, `dstConnectionId` and the embedded `type` are stripped
//     from each step's `configJson`: connection names are resolved here and
//     `type` is re-derived at execute time from (engine, action) by
//     `resolveTaskInput` in `src/main/template-utils.ts`.
//   - The renderer drives this directly with the connection list it already
//     has, so no new IPC channel is needed — the existing `templates.create`
//     handler persists the result.
//
// Pure: no I/O, no Electron, no fs. Easy to unit-test.
// Note: this module is imported by both the main process and the renderer,
// so it must stay free of Node-only APIs (e.g. `node:path`).

import type {
  CreateTemplateInput,
  MigrationTask,
  MigrationTaskPayload,
  TemplateStep,
  TemplateVariable
} from './types'

/** Placeholder used as the directory prefix for all export / import paths. */
export const DATA_DIR_VARIABLE = 'DATA_DIR'

export interface TasksToTemplateDraftOptions {
  /** Tasks in the order they should appear as template steps (click order). */
  tasks: MigrationTask[]
  /** Look up a connection name by its id. Returns undefined when missing. */
  connectionResolver: (id: string) => string | undefined
  /** Final template name (caller is responsible for validation / uniqueness). */
  name: string
  /** Optional description shown in the template list. */
  description?: string
  /** Default value for the `{{DATA_DIR}}` variable; empty string is fine. */
  dataDirDefault?: string
}

export interface TasksToTemplateDraftResult {
  /** Ready to hand to `templates.create`. `steps` and `variables` are always populated. */
  input: Omit<CreateTemplateInput, 'steps' | 'variables'> & {
    steps: TemplateStep[]
    variables: TemplateVariable[]
  }
  /** Non-fatal notes the UI may want to surface (e.g. dropped fields). */
  warnings: string[]
}

/** Custom error thrown when the input cannot be turned into a template. */
export class TasksToTemplateDraftError extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message)
    this.name = 'TasksToTemplateDraftError'
  }
}

/**
 * Build a `CreateTemplateInput` from the given tasks. Throws
 * `TasksToTemplateDraftError` when:
 *   - `tasks` is empty
 *   - a referenced connection id cannot be resolved (deleted connection)
 *   - a task's payload is missing or malformed
 */
export function tasksToTemplateDraft(
  options: TasksToTemplateDraftOptions
): TasksToTemplateDraftResult {
  const { tasks, connectionResolver, name, description, dataDirDefault } = options

  if (!name.trim()) {
    throw new TasksToTemplateDraftError('模板名称不能为空')
  }
  if (tasks.length === 0) {
    throw new TasksToTemplateDraftError('至少选择一个任务')
  }

  const warnings: string[] = []
  const steps: TemplateStep[] = []

  for (const task of tasks) {
    const connectionName = connectionResolver(task.connectionId)
    if (!connectionName) {
      throw new TasksToTemplateDraftError(
        `任务 ${task.id.slice(0, 8)} 引用了已不存在的连接（id: ${task.connectionId}），请取消勾选该任务。`
      )
    }
    const { engine, action } = mapTypeToEngineAction(task.type)
    const step = buildStep(task, engine, action, connectionName, warnings)
    steps.push(step)
  }

  const variables: TemplateVariable[] = [
    {
      name: DATA_DIR_VARIABLE,
      defaultValue: dataDirDefault ?? '',
      description:
        '导出 / 导入数据资源所在目录（占位符 {{DATA_DIR}}）；模板里所有 outputFile / inputFile 都位于此目录下。'
    }
  ]

  // Mirror the first step into the legacy top-level fields for backwards
  // compat with the single-step execution path (TemplateForm does the same).
  const first = steps[0]!

  const input = {
    name: name.trim(),
    description: description?.trim() || undefined,
    engine: first.engine,
    action: first.action,
    connectionName: first.connectionName,
    configJson: first.configJson,
    variables,
    steps
  } satisfies TasksToTemplateDraftResult['input']

  return { input, warnings }
}

interface EngineAction {
  engine: 'pgmigrator' | 'esmigrator'
  action: 'export' | 'import'
}

function mapTypeToEngineAction(
  type: MigrationTask['type']
): EngineAction {
  switch (type) {
    case 'postgres-export':
    case 'postgres-export-batch':
      return { engine: 'pgmigrator', action: 'export' }
    case 'postgres-import':
      return { engine: 'pgmigrator', action: 'import' }
    case 'elasticsearch-export':
      return { engine: 'esmigrator', action: 'export' }
    case 'elasticsearch-import':
      return { engine: 'esmigrator', action: 'import' }
  }
}

function buildStep(
  task: MigrationTask,
  engine: 'pgmigrator' | 'esmigrator',
  action: 'export' | 'import',
  connectionName: string,
  warnings: string[]
): TemplateStep {
  const payload = sanitizePayload(task.payload, task.id, warnings)
  return {
    id: crypto.randomUUID(),
    engine,
    action,
    connectionName,
    configJson: JSON.stringify(payload)
  }
}

/**
 * Strip fields that the runtime re-injects (connectionId, dstConnectionId)
 * or re-derives (type). Keep everything else verbatim so the resulting step
 * is a faithful snapshot of what was executed.
 */
function sanitizePayload(
  payload: MigrationTaskPayload,
  taskId: string,
  warnings: string[]
): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object') {
    throw new TasksToTemplateDraftError(
      `任务 ${taskId.slice(0, 8)} 的 payload 格式无效`
    )
  }
  const clone: Record<string, unknown> = { ...(payload as unknown as Record<string, unknown>) }

  // These three are dropped unconditionally; the rest of the rewrite happens
  // through the path helpers below.
  delete clone.connectionId
  delete clone.dstConnectionId
  delete clone.type

  if ('outputFile' in clone && typeof clone.outputFile === 'string') {
    clone.outputFile = rewriteFilePath(clone.outputFile)
  }
  if ('inputFile' in clone && typeof clone.inputFile === 'string') {
    clone.inputFile = rewriteFilePath(clone.inputFile)
  }
  if ('outputDirectory' in clone && typeof clone.outputDirectory === 'string') {
    clone.outputDirectory = rewriteDirectoryPath(clone.outputDirectory)
  }
  if ('tables' in clone && Array.isArray(clone.tables)) {
    // Sanity check: every table ref needs a schema + name. We don't rewrite
    // anything inside the array, but flag malformed entries so the user can
    // fix them in TemplatesPage.
    for (const entry of clone.tables) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as { schema?: unknown }).schema !== 'string' ||
        typeof (entry as { name?: unknown }).name !== 'string'
      ) {
        warnings.push(`任务 ${taskId.slice(0, 8)} 的 tables 数组含有异常项，已原样保留。`)
        break
      }
    }
  }
  return clone
}

/**
 * Replace the directory portion of a file path with `{{DATA_DIR}}`.
 *
 * - "/data/exports/users.jsonl"      → "{{DATA_DIR}}/users.jsonl"
 * - "users.jsonl"                   → "{{DATA_DIR}}/users.jsonl"
 * - "/data/{{TODAY}}-users.jsonl"   → "{{DATA_DIR}}/{{TODAY}}-users.jsonl"
 *
 * Empty / placeholder-only inputs are returned as-is so the user can fix
 * them by hand in TemplatesPage instead of us silently producing
 * `{{DATA_DIR}}/` with no filename.
 */
function rewriteFilePath(p: string): string {
  if (p.trim() === '') return p
  const file = basename(p)
  // `basename` of a string that ends with `/` returns the segment before the
  // trailing slash — guard so we don't lose a directory of empty filename.
  if (file === '' || file === '.' || file === '/') {
    return placeholder(DATA_DIR_VARIABLE)
  }
  return `${placeholder(DATA_DIR_VARIABLE)}/${file}`
}

/**
 * Replace the entire directory path with `{{DATA_DIR}}`. The original
 * trailing slash, if any, is preserved to keep semantics clear in the JSON.
 */
function rewriteDirectoryPath(p: string): string {
  if (p.trim() === '') return p
  // Preserve whether the user originally wrote a trailing slash.
  const hadTrailingSlash = p.endsWith('/') || p.endsWith('\\')
  return hadTrailingSlash
    ? `${placeholder(DATA_DIR_VARIABLE)}/`
    : placeholder(DATA_DIR_VARIABLE)
}

/** Wrap a variable name in the `{{...}}` placeholder syntax. */
function placeholder(name: string): string {
  return `{{${name}}}`
}

/**
 * Equivalent of Node's `path.basename` for the subset we need.
 * Handles both POSIX (`/`) and Windows (`\`) separators so a path typed on
 * either platform is stripped correctly when the user is on the other.
 */
function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx >= 0 ? p.slice(idx + 1) : p
}

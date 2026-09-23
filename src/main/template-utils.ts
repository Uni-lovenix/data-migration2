// Shared helpers for migration-template execution.
//
// `replaceVariables` and the built-in variables used to be duplicated in
// `src/main/index.ts` and `src/main/agent-service.ts`. This module is the
// single source of truth.

import type {
  CreateMigrationTaskInput,
  MigrationTemplate,
  MigrationTaskPayload,
  MigrationTaskType,
  TemplateAction,
  TemplateEngine,
  TemplateStep,
  TemplateVariable
} from '../shared/types'
import { exampleConfigJson } from '../shared/template-examples'

export { exampleConfigJson }

/**
 * Replace `{{NAME}}` placeholders inside a string with values from `vars`.
 *
 * - Substitutes keys that are present in `vars`.
 * - Leaves unknown keys untouched (the `{{NAME}}` token is preserved verbatim).
 * - Substitution is non-recursive: replaced values are not re-scanned.
 * - Keys must match `[A-Za-z0-9_]+` (regex `\\w+`).
 */
export function replaceVariables(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    key in vars ? vars[key] ?? match : match
  )
}

/**
 * Built-in variables available to every template execution. These are merged
 * underneath the user-supplied vars so the user can override them.
 */
export function builtInVars(now: Date = new Date()): Record<string, string> {
  return {
    TODAY: now.toISOString().slice(0, 10),
    NOW: now.toTimeString().slice(0, 8),
    TIMESTAMP: String(Math.floor(now.getTime() / 1000))
  }
}

/**
 * Map a (engine, action) pair to the canonical MigrationTaskType. Templates
 * historically stored `pgmigrator-export` style strings, but those don't match
 * any runtime task type — this function returns the actual runtime type.
 */
export function engineActionToTaskType(
  engine: TemplateEngine,
  action: TemplateAction
): MigrationTaskType {
  if (engine === 'pgmigrator' && action === 'export') return 'postgres-export'
  if (engine === 'pgmigrator' && action === 'import') return 'postgres-import'
  if (engine === 'esmigrator' && action === 'export') return 'elasticsearch-export'
  if (engine === 'esmigrator' && action === 'import') return 'elasticsearch-import'
  if (engine === 'mysqlmigrator' && action === 'export') return 'mysql-export'
  if (engine === 'mysqlmigrator' && action === 'import') return 'mysql-import'
  if (engine === 'sqlitemigrator' && action === 'export') return 'sqlite-export'
  if (engine === 'hivemigrator' && action === 'export') return 'hive-export'
  if (engine === 'hivemigrator' && action === 'import') return 'hive-import'
  if (engine === 'neo4jmigrator' && action === 'export') return 'neo4j-export'
  if (engine === 'accessmigrator' && action === 'export') return 'access-export'
  throw new Error(`不支持的模板操作：${engine}/${action}`)
}

/**
 * A working example `configJson` for each (engine, action) combination. Used
 * by the template form's "insert example" button and as the default for newly
 * created templates so the user can immediately see the supported shape.
 *
 * Implementation lives in `src/shared/template-examples.ts` so the renderer can
 * call it directly without IPC.
 */

/**
 * Inputs for {@link resolveTaskInput}. `connectionId` is required; `dstConnectionId`
 * is optional (only meaningful for import / cross-source flows).
 */
export interface ResolveTaskInputOptions {
  engine: TemplateEngine
  action: TemplateAction
  connectionId: string
  dstConnectionId?: string
  configJson: string
  vars: Record<string, string>
}

/**
 * Pure function that converts a template's configJson + resolved connection IDs
 * into a {@link CreateMigrationTaskInput}. Does no I/O — easy to unit-test.
 *
 * Steps:
 *   1. Substitute `{{VAR}}` placeholders inside `configJson` with `vars`.
 *   2. Parse the result as JSON.
 *   3. Inject `connectionId` (and `dstConnectionId` if provided) on top of the
 *      user payload so callers can't accidentally leave them empty.
 *   4. Honor `payload.type` from the JSON if present; otherwise map the
 *      `(engine, action)` pair to the canonical runtime task type.
 */
export function resolveTaskInput(options: ResolveTaskInputOptions): CreateMigrationTaskInput {
  const { engine, action, connectionId, dstConnectionId, configJson, vars } = options

  const resolvedJson = replaceVariables(configJson, vars)
  const payload = JSON.parse(resolvedJson) as MigrationTaskPayload & Record<string, unknown>
  payload.connectionId = connectionId
  if (dstConnectionId) {
    payload.dstConnectionId = dstConnectionId
  }

  const explicitType = typeof payload.type === 'string' ? (payload.type as MigrationTaskType) : undefined
  const type = explicitType ?? engineActionToTaskType(engine, action)
  // Strip the embedded type from payload before handing it to TaskManager —
  // TaskManager derives `type` from the input, not from the payload.
  delete (payload as Record<string, unknown>).type
  return { type, payload: payload as MigrationTaskPayload }
}

/**
 * One executable step — produced by {@link buildStepDescriptors} and fed into
 * {@link resolveTaskInput} after connection names have been resolved to ids.
 */
export interface ExecutableStep {
  name?: string
  engine: TemplateEngine
  action: TemplateAction
  connectionName: string
  dstConnectionName?: string
  configJson: string
  vars: Record<string, string>
}

/**
 * Build the ordered list of steps to execute for a template.
 *
 * - Templates without `steps` (legacy single-task) become one step derived
 *   from the top-level fields.
 * - Templates with `steps` iterate them in order.
 *
 * Variable merging precedence (later overrides earlier):
 *   built-in (TODAY / NOW / TIMESTAMP) → user vars → step-level vars.
 */
export function buildStepDescriptors(
  tmpl: MigrationTemplate,
  vars: Record<string, string>
): ExecutableStep[] {
  const templateVars = Object.fromEntries(
    tmpl.variables.map((v) => [v.name, v.defaultValue ?? ''])
  )
  // Variable merging precedence (later overrides earlier):
  // built-in → template-level → user-supplied → step-level.
  const baseVars = { ...builtInVars(), ...templateVars, ...vars }
  if (tmpl.steps.length > 0) {
    return tmpl.steps.map((step) => ({
      name: step.name,
      engine: step.engine,
      action: step.action,
      connectionName: step.connectionName,
      dstConnectionName: step.dstConnectionName,
      configJson: step.configJson,
      vars: mergeStepVars(baseVars, step.variables)
    }))
  }
  return [
    {
      engine: tmpl.engine,
      action: tmpl.action,
      connectionName: tmpl.connectionName,
      dstConnectionName: tmpl.dstConnectionName,
      configJson: tmpl.configJson,
      vars: baseVars
    }
  ]
}

function mergeStepVars(
  base: Record<string, string>,
  stepVars: TemplateVariable[] | undefined
): Record<string, string> {
  if (!stepVars || stepVars.length === 0) return base
  const merged = { ...base }
  for (const v of stepVars) {
    merged[v.name] = v.defaultValue ?? ''
  }
  return merged
}

/**
 * Collect every variable used by a template (template-level + every step).
 * Used by the renderer's execute modal to surface every placeholder the user
 * might need to fill in.
 */
export function collectTemplateVariables(tmpl: MigrationTemplate): TemplateVariable[] {
  const seen = new Set<string>()
  const out: TemplateVariable[] = []
  const push = (v: TemplateVariable): void => {
    if (seen.has(v.name)) return
    seen.add(v.name)
    out.push(v)
  }
  for (const v of tmpl.variables) push(v)
  const sources = tmpl.steps.length > 0 ? tmpl.steps : [legacyTopLevelStep(tmpl)]
  for (const step of sources) {
    for (const v of step.variables ?? []) push(v)
  }
  return out
}

function legacyTopLevelStep(tmpl: MigrationTemplate): TemplateStep {
  return {
    id: 'legacy',
    engine: tmpl.engine,
    action: tmpl.action,
    connectionName: tmpl.connectionName,
    dstConnectionName: tmpl.dstConnectionName,
    configJson: tmpl.configJson,
    variables: tmpl.variables
  }
}

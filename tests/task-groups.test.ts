import { describe, expect, it } from 'vitest'

import { groupTasksByTemplate } from '../src/shared/task-groups'
import type { MigrationTask, TaskTemplateMetadata } from '../src/shared/types'

describe('groupTasksByTemplate', () => {
  it('groups one template run and orders its steps', () => {
    const first = task('first', template('run-1', '模板 A', 3, 3))
    const second = task('second', template('run-1', '模板 A', 2, 3))
    const third = task('third', template('run-1', '模板 A', 1, 3))
    const groups = groupTasksByTemplate([first, second, third])

    expect(groups).toHaveLength(1)
    expect(groups[0]!.template?.templateName).toBe('模板 A')
    expect(groups[0]!.tasks.map((item) => item.id)).toEqual(['third', 'second', 'first'])
  })

  it('keeps repeated runs of the same template separate', () => {
    const firstRun = task('first-run', template('run-1', '模板 A', 1, 1))
    const secondRun = task('second-run', template('run-2', '模板 A', 1, 1))
    const groups = groupTasksByTemplate([firstRun, secondRun])

    expect(groups.map((group) => group.key)).toEqual([
      'template:run-1',
      'template:run-2'
    ])
  })

  it('keeps tasks without template metadata as individual groups', () => {
    const first = task('first')
    const second = task('second')
    const groups = groupTasksByTemplate([first, second])

    expect(groups).toHaveLength(2)
    expect(groups.map((group) => group.key)).toEqual(['task:first', 'task:second'])
  })

  it('infers groups for legacy dependency chains', () => {
    const third = task('third')
    third.dependsOn = ['second']
    const second = task('second')
    second.dependsOn = ['first']
    const first = task('first')
    const groups = groupTasksByTemplate([third, second, first])

    expect(groups).toHaveLength(1)
    expect(groups[0]!.inferred).toBe(true)
    expect(groups[0]!.template?.templateName).toBe('历史依赖任务组')
    expect(groups[0]!.tasks.map((item) => item.id)).toEqual(['first', 'second', 'third'])
  })
})

function task(id: string, taskTemplate?: TaskTemplateMetadata): MigrationTask {
  return {
    id,
    type: 'postgres-export',
    status: 'queued',
    connectionId: 'connection-1',
    payload: {
      connectionId: 'connection-1',
      table: { schema: 'public', name: 'users' },
      outputFile: `/tmp/${id}.jsonl`,
      batchSize: 500
    },
    ...(taskTemplate ? { template: taskTemplate } : {}),
    progress: 0,
    createdAt: '2026-09-23T00:00:00.000Z'
  }
}

function template(
  runId: string,
  templateName: string,
  stepIndex: number,
  stepCount: number
): TaskTemplateMetadata {
  return {
    runId,
    templateId: 'template-1',
    templateName,
    stepIndex,
    stepCount
  }
}

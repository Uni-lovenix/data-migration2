import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TaskStore } from '../src/main/task-store'
import type { MigrationTask } from '../src/shared/types'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('TaskStore', () => {
  it('persists task state across store instances', async () => {
    const directory = await makeTemporaryDirectory()
    const filePath = join(directory, 'tasks.db')
    const store = new TaskStore(filePath)
    await store.initialize()

    const task = createTask()
    store.insert(task)
    expect(store.get(task.id).status).toBe('queued')
    expect(store.list()).toHaveLength(1)

    task.status = 'running'
    task.progress = 42
    task.cursor = { rows: 42 }
    store.update(task)
    expect(store.get(task.id).progress).toBe(42)
    expect(store.get(task.id).cursor).toEqual({ rows: 42 })
    store.close()

    const reloaded = new TaskStore(filePath)
    await reloaded.initialize()
    const persisted = reloaded.get(task.id)
    expect(persisted.status).toBe('running')
    expect(persisted.cursor).toEqual({ rows: 42 })
    reloaded.close()
  })

  it('throws for missing tasks', async () => {
    const directory = await makeTemporaryDirectory()
    const store = new TaskStore(join(directory, 'tasks.db'))
    await store.initialize()

    expect(() => store.get('missing')).toThrow('任务不存在')
    store.close()
  })
})

function createTask(): MigrationTask {
  return {
    id: 'task-1',
    type: 'postgres-export',
    status: 'queued',
    connectionId: 'connection-1',
    payload: {
      connectionId: 'connection-1',
      table: { schema: 'public', name: 'users' },
      outputFile: '/tmp/users.jsonl',
      batchSize: 500
    },
    progress: 0,
    cursor: { rows: 0 },
    createdAt: '2026-08-26T00:00:00.000Z'
  }
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'data-migrator-task-store-test-'))
  temporaryDirectories.push(directory)
  return directory
}

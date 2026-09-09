import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { StructuredLogger } from '../src/main/logger'
import { TaskManager } from '../src/main/task-manager'
import { TaskStore } from '../src/main/task-store'
import type {
  ConnectionConfig,
  CreateMigrationTaskInput
} from '../src/shared/types'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('TaskManager', () => {
  it('runs a queued task and persists progress', async () => {
    const context = await createContext()
    context.postgres.exportTable.mockImplementation(
      async (_connection: ConnectionConfig, _request: unknown, onProgress?: (...args: unknown[]) => void) => {
        onProgress?.(5, { rows: 5 })
        return { rows: 5, durationMs: 1, table: { schema: 'public', name: 'users' } }
      }
    )

    const task = context.manager.create(postgresExportInput())

    await waitFor(() => context.manager.get(task.id).status === 'completed')
    const latest = context.manager.get(task.id)
    expect(latest.progress).toBe(5)
    expect(latest.cursor).toEqual({ rows: 5 })
    expect(context.store.get(task.id).status).toBe('completed')
    context.close()
  })

  it('cancels a running task and resumes from its cursor', async () => {
    const context = await createContext()
    let release!: () => void
    let resumed = false
    context.postgres.exportTable.mockImplementation(
      async (_connection: ConnectionConfig, _request: unknown, onProgress?: (...args: unknown[]) => void) => {
        if (!resumed) {
          onProgress?.(1, { rows: 1 })
          await new Promise<void>((resolve) => {
            release = () => {
              resumed = true
              resolve()
            }
          })
        } else {
          onProgress?.(2, { rows: 2 })
        }
        return { rows: resumed ? 2 : 1, durationMs: 1, table: { schema: 'public', name: 'users' } }
      }
    )

    const task = context.manager.create(postgresExportInput())
    await waitFor(() => context.manager.get(task.id).status === 'running')
    context.manager.cancel(task.id)
    release()
    await waitFor(() => context.manager.get(task.id).status === 'canceled')
    expect(context.manager.get(task.id).progress).toBe(1)

    context.manager.resume(task.id)
    await waitFor(() => context.manager.get(task.id).status === 'completed')
    const latest = context.manager.get(task.id)
    expect(latest.progress).toBe(2)
    expect(context.postgres.exportTable.mock.calls[1]?.[3]).toBe(1)
    context.close()
  })

  it('runs a multi-table export task and resumes from its table cursor', async () => {
    const context = await createContext()
    context.postgres.exportTables.mockImplementation(
      async (
        _connection: ConnectionConfig,
        _request: unknown,
        onProgress?: (...args: unknown[]) => void
      ) => {
        onProgress?.(4, { tableIndex: 1, rows: 4 })
        return { rows: 4, bytes: 80, durationMs: 1, tables: [] }
      }
    )

    const task = context.manager.create({
      type: 'postgres-export-batch',
      payload: {
        connectionId: 'connection-1',
        tables: [
          { schema: 'public', name: 'users' },
          { schema: 'public', name: 'orders' }
        ],
        outputDirectory: '/tmp/export',
        batchSize: 500
      }
    })

    await waitFor(() => context.manager.get(task.id).status === 'completed')
    expect(context.manager.get(task.id).progress).toBe(4)
    expect(context.manager.get(task.id).cursor).toEqual({ tableIndex: 1, rows: 4 })

    const paused = context.manager.get(task.id)
    paused.status = 'paused'
    paused.cursor = { tableIndex: 1, rows: 4 }
    context.store.update(paused)
    context.manager.resume(paused.id)
    await waitFor(() => context.manager.get(task.id).status === 'completed')
    expect(context.postgres.exportTables.mock.calls[1]?.[3]).toEqual({
      tableIndex: 1,
      rows: 4
    })
    context.close()
  })
})

interface TestContext {
  manager: TaskManager
  store: TaskStore
  postgres: {
    exportTable: ReturnType<typeof vi.fn>
    exportTables: ReturnType<typeof vi.fn>
    importJsonl: ReturnType<typeof vi.fn>
  }
  elasticsearch: {
    exportIndex: ReturnType<typeof vi.fn>
    importJsonl: ReturnType<typeof vi.fn>
  }
  close: () => void
}

async function createContext(): Promise<TestContext> {
  const directory = await makeTemporaryDirectory()
  const store = new TaskStore(join(directory, 'tasks.db'))
  await store.initialize()
  const logger = new StructuredLogger(join(directory, 'migration.log'))
  const postgres = {
    exportTable: vi.fn(),
    exportTables: vi.fn(),
    importJsonl: vi.fn()
  }
  const elasticsearch = { exportIndex: vi.fn(), importJsonl: vi.fn() }
  const connection: ConnectionConfig = {
    id: 'connection-1',
    name: '测试库',
    type: 'postgresql',
    host: 'localhost',
    port: 5432,
    database: 'app',
    ssl: false,
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z'
  }
  const manager = new TaskManager({
    store,
    logger,
    connections: { get: vi.fn(async () => connection) },
    postgres: postgres as any,
    elasticsearch: elasticsearch as any,
    onChanged: vi.fn()
  })
  return {
    manager,
    store,
    postgres,
    elasticsearch,
    close: () => {
      store.close()
      logger.close()
      void rm(directory, { recursive: true, force: true })
    }
  }
}

function postgresExportInput(): CreateMigrationTaskInput {
  return {
    type: 'postgres-export',
    payload: {
      connectionId: 'connection-1',
      table: { schema: 'public', name: 'users' },
      outputFile: '/tmp/users.jsonl',
      batchSize: 500
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待任务状态超时')
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'data-migrator-task-manager-test-'))
  temporaryDirectories.push(directory)
  return directory
}

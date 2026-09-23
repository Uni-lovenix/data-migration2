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
  it('creates a pending task without starting it', async () => {
    const context = await createContext()

    const task = context.manager.create({
      ...postgresExportInput(),
      start: false
    })

    expect(task.status).toBe('created')
    expect(context.manager.get(task.id).status).toBe('created')
    expect(context.store.get(task.id).status).toBe('created')
    expect(context.postgres.exportTable).not.toHaveBeenCalled()

    context.manager.resume(task.id)
    await waitFor(() => context.manager.get(task.id).status === 'completed')
    expect(context.postgres.exportTable).toHaveBeenCalledTimes(1)
    context.close()
  })

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

  it('runs queued tasks in parallel up to the configured concurrency', async () => {
    const context = await createContext(2)
    const releases = new Map<string, () => void>()
    context.postgres.exportTable.mockImplementation(
      (
        _connection: ConnectionConfig,
        request: { outputFile: string },
        onProgress?: (...args: unknown[]) => void
      ) =>
        new Promise((resolve) => {
          releases.set(request.outputFile, () => {
            onProgress?.(1, { rows: 1 })
            resolve({
              rows: 1,
              durationMs: 1,
              table: { schema: 'public', name: 'users' }
            })
          })
        })
    )

    const first = context.manager.create(postgresExportInput('first.jsonl'))
    const second = context.manager.create(postgresExportInput('second.jsonl'))
    const third = context.manager.create(postgresExportInput('third.jsonl'))

    await waitFor(
      () =>
        context.manager.get(first.id).status === 'running' &&
        context.manager.get(second.id).status === 'running'
    )
    expect(context.manager.get(third.id).status).toBe('queued')
    expect(context.postgres.exportTable).toHaveBeenCalledTimes(2)

    releases.get('/tmp/first.jsonl')?.()
    await waitFor(() => context.manager.get(third.id).status === 'running')
    expect(context.manager.get(second.id).status).toBe('running')
    expect(context.postgres.exportTable).toHaveBeenCalledTimes(3)

    releases.get('/tmp/second.jsonl')?.()
    releases.get('/tmp/third.jsonl')?.()
    await waitFor(
      () =>
        context.manager.get(first.id).status === 'completed' &&
        context.manager.get(second.id).status === 'completed' &&
        context.manager.get(third.id).status === 'completed'
    )
    context.close()
  })

  it('keeps draining queued tasks when one parallel task fails', async () => {
    const context = await createContext(2)
    const releases = new Map<string, () => void>()
    context.postgres.exportTable.mockImplementation(
      (
        _connection: ConnectionConfig,
        request: { outputFile: string },
        onProgress?: (...args: unknown[]) => void
      ) => {
        if (request.outputFile.endsWith('/failed.jsonl')) {
          return Promise.reject(new Error('模拟失败'))
        }
        return new Promise((resolve) => {
          releases.set(request.outputFile, () => {
            onProgress?.(1, { rows: 1 })
            resolve({
              rows: 1,
              durationMs: 1,
              table: { schema: 'public', name: 'users' }
            })
          })
        })
      }
    )

    const failed = context.manager.create(postgresExportInput('failed.jsonl'))
    const waiting = context.manager.create(postgresExportInput('waiting.jsonl'))
    const queued = context.manager.create(postgresExportInput('queued.jsonl'))

    await waitFor(() => context.manager.get(failed.id).status === 'failed')
    await waitFor(() => context.manager.get(queued.id).status === 'running')
    expect(context.manager.get(waiting.id).status).toBe('running')

    releases.get('/tmp/waiting.jsonl')?.()
    releases.get('/tmp/queued.jsonl')?.()
    await waitFor(
      () =>
        context.manager.get(waiting.id).status === 'completed' &&
        context.manager.get(queued.id).status === 'completed'
    )
    context.close()
  })

  it('waits for task dependencies before starting a dependent task', async () => {
    const context = await createContext(4)
    const startedFiles: string[] = []
    let releasePrerequisite!: () => void
    context.postgres.exportTable.mockImplementation(
      (
        _connection: ConnectionConfig,
        request: { outputFile: string },
        onProgress?: (...args: unknown[]) => void
      ) => {
        startedFiles.push(request.outputFile)
        if (request.outputFile.endsWith('/export.jsonl')) {
          return new Promise((resolve) => {
            releasePrerequisite = () => {
              onProgress?.(1, { rows: 1 })
              resolve({
                rows: 1,
                durationMs: 1,
                table: { schema: 'public', name: 'users' }
              })
            }
          })
        }
        onProgress?.(1, { rows: 1 })
        return Promise.resolve({
          rows: 1,
          durationMs: 1,
          table: { schema: 'public', name: 'users' }
        })
      }
    )

    const prerequisite = context.manager.create(postgresExportInput('export.jsonl'))
    const dependent = context.manager.create({
      ...postgresExportInput('import.jsonl'),
      dependsOn: [prerequisite.id]
    })

    await waitFor(() => context.manager.get(prerequisite.id).status === 'running')
    expect(context.manager.get(dependent.id).status).toBe('queued')
    expect(startedFiles).toEqual(['/tmp/export.jsonl'])

    releasePrerequisite()
    await waitFor(() => context.manager.get(dependent.id).status === 'completed')
    expect(startedFiles).toEqual(['/tmp/export.jsonl', '/tmp/import.jsonl'])
    context.close()
  })

  it('fails a dependent task without running it when its prerequisite fails', async () => {
    const context = await createContext(4)
    const startedFiles: string[] = []
    context.postgres.exportTable.mockImplementation(
      (_connection: ConnectionConfig, request: { outputFile: string }) => {
        startedFiles.push(request.outputFile)
        if (request.outputFile.endsWith('/export.jsonl')) {
          return Promise.reject(new Error('导出失败'))
        }
        return Promise.resolve({
          rows: 1,
          durationMs: 1,
          table: { schema: 'public', name: 'users' }
        })
      }
    )

    const prerequisite = context.manager.create(postgresExportInput('export.jsonl'))
    const dependent = context.manager.create({
      ...postgresExportInput('import.jsonl'),
      dependsOn: [prerequisite.id]
    })

    await waitFor(() => context.manager.get(dependent.id).status === 'failed')
    expect(context.manager.get(prerequisite.id).status).toBe('failed')
    expect(context.manager.get(dependent.id).error).toContain(prerequisite.id)
    expect(startedFiles).toEqual(['/tmp/export.jsonl'])
    context.close()
  })

  it('supports explicit serial execution with concurrency 1', async () => {
    const context = await createContext(1)
    const startedFiles: string[] = []
    let releaseFirst!: () => void
    context.postgres.exportTable.mockImplementation(
      (
        _connection: ConnectionConfig,
        request: { outputFile: string }
      ) => {
        startedFiles.push(request.outputFile)
        if (request.outputFile === '/tmp/first.jsonl') {
          return new Promise((resolve) => {
            releaseFirst = () =>
              resolve({
                rows: 1,
                durationMs: 1,
                table: { schema: 'public', name: 'users' }
              })
          })
        }
        return Promise.resolve({
          rows: 1,
          durationMs: 1,
          table: { schema: 'public', name: 'users' }
        })
      }
    )

    const first = context.manager.create(postgresExportInput('first.jsonl'))
    const second = context.manager.create(postgresExportInput('second.jsonl'))

    await waitFor(() => context.manager.get(first.id).status === 'running')
    expect(context.manager.get(second.id).status).toBe('queued')
    expect(startedFiles).toEqual(['/tmp/first.jsonl'])

    releaseFirst()
    await waitFor(() => context.manager.get(second.id).status === 'completed')
    expect(startedFiles).toEqual(['/tmp/first.jsonl', '/tmp/second.jsonl'])
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

  it('routes mysql-export tasks and resumes from the stored row cursor', async () => {
    const context = await createContext()
    context.mysql.exportTable.mockImplementation(
      async (_connection: ConnectionConfig, _request: unknown, onProgress?: (...args: unknown[]) => void) => {
        onProgress?.(7, { rows: 7 })
        return { rows: 7, bytes: 70, durationMs: 1, table: { schema: 'app', name: 'users' } }
      }
    )

    const task = context.manager.create({
      type: 'mysql-export',
      payload: {
        connectionId: 'connection-1',
        table: { schema: 'app', name: 'users' },
        outputFile: '/tmp/users.jsonl',
        batchSize: 500
      }
    })

    await waitFor(() => context.manager.get(task.id).status === 'completed')
    expect(context.manager.get(task.id).progress).toBe(7)
    expect(context.manager.get(task.id).cursor).toEqual({ rows: 7 })

    const paused = context.manager.get(task.id)
    paused.status = 'paused'
    context.store.update(paused)
    context.manager.resume(paused.id)
    await waitFor(() => context.manager.get(task.id).status === 'completed')
    expect(context.mysql.exportTable.mock.calls[1]?.[3]).toBe(7)
    context.close()
  })

  it('routes mysql-export-batch tasks and forwards the table cursor', async () => {
    const context = await createContext()
    context.mysql.exportTables.mockImplementation(
      async (
        _connection: ConnectionConfig,
        _request: unknown,
        onProgress?: (...args: unknown[]) => void
      ) => {
        onProgress?.(4, { tableIndex: 1, rows: 4 })
        return { rows: 4, bytes: 40, durationMs: 1, tables: [] }
      }
    )

    const task = context.manager.create({
      type: 'mysql-export-batch',
      payload: {
        connectionId: 'connection-1',
        tables: [
          { schema: 'app', name: 'users' },
          { schema: 'app', name: 'orders' }
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
    expect(context.mysql.exportTables.mock.calls[1]?.[3]).toEqual({
      tableIndex: 1,
      rows: 4
    })
    context.close()
  })

  it('routes sqlite-export tasks and resumes from the stored row cursor', async () => {
    const context = await createContext()
    context.sqlite.exportTable.mockImplementation(
      async (_connection: ConnectionConfig, _request: unknown, onProgress?: (...args: unknown[]) => void) => {
        onProgress?.(3, { rows: 3 })
        return { rows: 3, bytes: 30, durationMs: 1, table: { schema: 'main', name: 'users' } }
      }
    )

    const task = context.manager.create({
      type: 'sqlite-export',
      payload: {
        connectionId: 'connection-1',
        table: { schema: 'main', name: 'users' },
        outputFile: '/tmp/users.jsonl',
        batchSize: 500
      }
    })

    await waitFor(() => context.manager.get(task.id).status === 'completed')
    expect(context.manager.get(task.id).progress).toBe(3)
    expect(context.manager.get(task.id).cursor).toEqual({ rows: 3 })

    const paused = context.manager.get(task.id)
    paused.status = 'paused'
    context.store.update(paused)
    context.manager.resume(paused.id)
    await waitFor(() => context.manager.get(task.id).status === 'completed')
    expect(context.sqlite.exportTable.mock.calls[1]?.[3]).toBe(3)
    context.close()
  })

  it('routes hive-export tasks and resumes from the stored row cursor', async () => {
    const context = await createContext()
    context.hive.exportTable.mockImplementation(
      async (_connection: ConnectionConfig, _request: unknown, onProgress?: (...args: unknown[]) => void) => {
        onProgress?.(6, { rows: 6 })
        return { rows: 6, bytes: 60, durationMs: 1, table: { database: 'default', name: 'events' } }
      }
    )

    const task = context.manager.create({
      type: 'hive-export',
      payload: {
        connectionId: 'connection-1',
        table: { database: 'default', name: 'events' },
        outputFile: '/tmp/events.jsonl',
        batchSize: 500
      }
    })

    await waitFor(() => context.manager.get(task.id).status === 'completed')
    expect(context.manager.get(task.id).progress).toBe(6)
    const paused = context.manager.get(task.id)
    paused.status = 'paused'
    context.store.update(paused)
    context.manager.resume(paused.id)
    await waitFor(() => context.manager.get(task.id).status === 'completed')
    expect(context.hive.exportTable.mock.calls[1]?.[3]).toBe(6)
    context.close()
  })

  it('preserves the parallel Elasticsearch export cursor on resume', async () => {
    const context = await createContext()
    const cursor = {
      rows: 2,
      slices: [{ id: 0, rows: 1 }, { id: 1, rows: 1 }]
    }
    context.elasticsearch.exportIndex.mockImplementation(
      async (
        _connection: ConnectionConfig,
        _request: unknown,
        onProgress?: (...args: unknown[]) => void
      ) => {
        onProgress?.(2, cursor)
        return { rows: 2, bytes: 20, durationMs: 1, index: 'logs' }
      }
    )

    const task = context.manager.create({
      type: 'elasticsearch-export',
      payload: {
        connectionId: 'connection-1',
        index: 'logs',
        outputFile: '/tmp/logs.jsonl',
        batchSize: 500,
        concurrency: 4,
        strategy: 'search_after'
      }
    })

    await waitFor(() => context.manager.get(task.id).status === 'completed')
    expect(context.manager.get(task.id).cursor).toEqual(cursor)

    const paused = context.manager.get(task.id)
    paused.status = 'paused'
    context.store.update(paused)
    context.manager.resume(task.id)
    await waitFor(() => context.manager.get(task.id).status === 'completed')
    expect(context.elasticsearch.exportIndex.mock.calls[1]?.[3]).toEqual({
      rows: 2,
      searchAfter: undefined,
      cursor
    })
    context.close()
  })

  it('routes hive-import tasks and resumes from the stored line cursor', async () => {
    const context = await createContext()
    context.hive.importJsonl.mockImplementation(
      async (_connection: ConnectionConfig, _request: unknown, onProgress?: (...args: unknown[]) => void) => {
        onProgress?.(2, 3)
        return { rows: 2, durationMs: 1, table: { database: 'default', name: 'events' } }
      }
    )

    const task = context.manager.create({
      type: 'hive-import',
      payload: {
        connectionId: 'connection-1',
        table: { database: 'default', name: 'events' },
        inputFile: '/tmp/events.jsonl',
        batchSize: 500
      }
    })

    await waitFor(() => context.manager.get(task.id).status === 'completed')
    expect(context.manager.get(task.id).cursor).toEqual({ lines: 3, rows: 2 })
    const paused = context.manager.get(task.id)
    paused.status = 'paused'
    context.store.update(paused)
    context.manager.resume(paused.id)
    await waitFor(() => context.manager.get(task.id).status === 'completed')
    expect(context.hive.importJsonl.mock.calls[1]?.[3]).toEqual({ lines: 3, rows: 2 })
    context.close()
  })

  it('routes neo4j-export tasks and resumes from the stored row cursor', async () => {
    const context = await createContext()
    context.neo4j.exportTable.mockImplementation(
      async (_connection: ConnectionConfig, _request: unknown, onProgress?: (...args: unknown[]) => void) => {
        onProgress?.(4)
        return { rows: 4, bytes: 40, durationMs: 1, table: { kind: 'node', name: 'Person' } }
      }
    )

    const task = context.manager.create({
      type: 'neo4j-export',
      payload: {
        connectionId: 'connection-1',
        kind: 'node',
        name: 'Person',
        outputFile: '/tmp/person.jsonl',
        batchSize: 500
      }
    })

    await waitFor(() => context.manager.get(task.id).status === 'completed')
    const paused = context.manager.get(task.id)
    paused.status = 'paused'
    context.store.update(paused)
    context.manager.resume(paused.id)
    await waitFor(() => context.manager.get(task.id).status === 'completed')
    expect(context.neo4j.exportTable.mock.calls[1]?.[3]).toBe(4)
    context.close()
  })

  it('routes access-export tasks and resumes from the stored row cursor', async () => {
    const context = await createContext()
    context.access.exportTable.mockImplementation(
      async (_connection: ConnectionConfig, _request: unknown, onProgress?: (...args: unknown[]) => void) => {
        onProgress?.(3, { rows: 3 })
        return { rows: 3, bytes: 30, durationMs: 1, table: 'Users' }
      }
    )

    const task = context.manager.create({
      type: 'access-export',
      payload: {
        connectionId: 'connection-1',
        table: 'Users',
        outputFile: '/tmp/users.jsonl',
        batchSize: 500
      }
    })

    await waitFor(() => context.manager.get(task.id).status === 'completed')
    const paused = context.manager.get(task.id)
    paused.status = 'paused'
    context.store.update(paused)
    context.manager.resume(paused.id)
    await waitFor(() => context.manager.get(task.id).status === 'completed')
    expect(context.access.exportTable.mock.calls[1]?.[3]).toBe(3)
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
  mysql: {
    exportTable: ReturnType<typeof vi.fn>
    exportTables: ReturnType<typeof vi.fn>
  }
  sqlite: {
    exportTable: ReturnType<typeof vi.fn>
    exportTables: ReturnType<typeof vi.fn>
  }
  hive: {
    exportTable: ReturnType<typeof vi.fn>
    importJsonl: ReturnType<typeof vi.fn>
  }
  neo4j: {
    exportTable: ReturnType<typeof vi.fn>
  }
  access: {
    exportTable: ReturnType<typeof vi.fn>
  }
  close: () => void
}

async function createContext(concurrency?: number): Promise<TestContext> {
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
  const mysql = { exportTable: vi.fn(), exportTables: vi.fn() }
  const sqlite = { exportTable: vi.fn(), exportTables: vi.fn() }
  const hive = { exportTable: vi.fn(), importJsonl: vi.fn() }
  const neo4j = { exportTable: vi.fn() }
  const access = { exportTable: vi.fn() }
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
    mysql: mysql as any,
    sqlite: sqlite as any,
    hive: hive as any,
    neo4j: neo4j as any,
    access: access as any,
    onChanged: vi.fn(),
    concurrency
  })
  return {
    manager,
    store,
    postgres,
    elasticsearch,
    mysql,
    sqlite,
    hive,
    neo4j,
    access,
    close: () => {
      store.close()
      logger.close()
      void rm(directory, { recursive: true, force: true })
    }
  }
}

function postgresExportInput(outputFile = 'users.jsonl'): CreateMigrationTaskInput {
  return {
    type: 'postgres-export',
    payload: {
      connectionId: 'connection-1',
      table: { schema: 'public', name: 'users' },
      outputFile: `/tmp/${outputFile}`,
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

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { StructuredLogger } from '../src/main/logger'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('StructuredLogger', () => {
  it('writes JSON lines with timestamp, level, service and message', async () => {
    const directory = await makeTemporaryDirectory()
    const filePath = join(directory, 'migration.log')
    const logger = new StructuredLogger(filePath)
    logger.info('task-manager', 'task_queued', { taskId: 'task-1' })
    logger.error('task-manager', 'task_failed', { taskId: 'task-1', error: 'boom' })
    await logger.close()

    const lines = (await readFile(filePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      timestamp: expect.any(String),
      level: 'info',
      service: 'task-manager',
      message: 'task_queued',
      taskId: 'task-1'
    })
    expect(lines[1]).toMatchObject({
      level: 'error',
      message: 'task_failed',
      error: 'boom'
    })
  })
})

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'data-migrator-logger-test-'))
  temporaryDirectories.push(directory)
  return directory
}

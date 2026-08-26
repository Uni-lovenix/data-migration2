import { describe, expect, it } from 'vitest'

import {
  defaultPortForType,
  validateCreateMigrationTaskInput,
  validateElasticsearchExportRequest,
  validateElasticsearchImportRequest,
  validatePostgresExportRequest,
  validatePostgresImportRequest,
  validateConnectionInput
} from '../src/shared/validation'

describe('validateConnectionInput', () => {
  it('accepts a valid PostgreSQL connection and trims string fields', () => {
    const result = validateConnectionInput({
      name: '  生产库  ',
      type: 'postgresql',
      host: ' db.internal ',
      port: 5432,
      username: 'migrator',
      password: 'secret',
      database: 'analytics',
      ssl: true
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.name).toBe('生产库')
    expect(result.value.host).toBe('db.internal')
    expect(result.value.database).toBe('analytics')
  })

  it('accepts a valid Elasticsearch connection without a database', () => {
    const result = validateConnectionInput({
      name: '搜索集群',
      type: 'elasticsearch',
      host: 'es.internal',
      port: 9200,
      defaultIndex: 'logs-*',
      ssl: false
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.defaultIndex).toBe('logs-*')
    expect(result.value.database).toBeUndefined()
  })

  it('rejects invalid type, host and port values', () => {
    const result = validateConnectionInput({
      name: '',
      type: 'oracle',
      host: '',
      port: 70000,
      ssl: false
    })

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.errors).toHaveLength(4)
  })

  it('normalizes empty optional fields to undefined', () => {
    const result = validateConnectionInput({
      name: '连接',
      type: 'postgresql',
      host: 'localhost',
      port: 5432,
      username: '',
      password: '  ',
      ssl: true
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.username).toBeUndefined()
    expect(result.value.password).toBeUndefined()
  })
})

describe('defaultPortForType', () => {
  it('returns standard ports', () => {
    expect(defaultPortForType('postgresql')).toBe(5432)
    expect(defaultPortForType('elasticsearch')).toBe(9200)
  })
})

describe('PostgreSQL migration validation', () => {
  it('accepts valid export and import requests', () => {
    const exportResult = validatePostgresExportRequest({
      connectionId: 'connection-1',
      table: { schema: 'public', name: 'users' },
      outputFile: '/tmp/users.jsonl',
      batchSize: 500
    })
    expect(exportResult.ok).toBe(true)

    const importResult = validatePostgresImportRequest({
      connectionId: 'connection-1',
      table: { schema: 'public', name: 'users' },
      inputFile: '/tmp/users.jsonl',
      batchSize: 500,
      onConflict: 'error'
    })
    expect(importResult.ok).toBe(true)
    if (importResult.ok) {
      expect(importResult.value.onConflict).toBe('error')
    }
  })

  it('defaults import conflict handling to skip and rejects invalid values', () => {
    const importResult = validatePostgresImportRequest({
      connectionId: 'connection-1',
      table: { schema: 'public', name: 'users' },
      inputFile: '/tmp/users.jsonl',
      batchSize: 500
    })
    expect(importResult.ok).toBe(true)
    if (importResult.ok) {
      expect(importResult.value.onConflict).toBe('skip')
    }

    const exportResult = validatePostgresExportRequest({
      connectionId: '',
      table: { schema: '', name: '' },
      outputFile: '',
      batchSize: 0
    })
    expect(exportResult.ok).toBe(false)
    if (!exportResult.ok) {
      expect(exportResult.errors).toHaveLength(5)
    }
  })
})

describe('Elasticsearch migration validation', () => {
  it('accepts valid export and import requests', () => {
    const exportResult = validateElasticsearchExportRequest({
      connectionId: 'connection-1',
      index: 'logs',
      outputFile: '/tmp/logs.jsonl',
      batchSize: 500,
      strategy: 'search_after'
    })
    expect(exportResult.ok).toBe(true)
    if (exportResult.ok) {
      expect(exportResult.value.strategy).toBe('search_after')
    }

    const importResult = validateElasticsearchImportRequest({
      connectionId: 'connection-1',
      index: 'logs',
      inputFile: '/tmp/logs.jsonl',
      batchSize: 500,
      onConflict: 'overwrite'
    })
    expect(importResult.ok).toBe(true)
    if (importResult.ok) {
      expect(importResult.value.onConflict).toBe('overwrite')
    }
  })

  it('defaults strategy and conflict handling and rejects invalid values', () => {
    const exportResult = validateElasticsearchExportRequest({
      connectionId: 'connection-1',
      index: 'logs',
      outputFile: '/tmp/logs.jsonl',
      batchSize: 500
    })
    expect(exportResult.ok).toBe(true)
    if (exportResult.ok) {
      expect(exportResult.value.strategy).toBe('scroll')
    }

    const importResult = validateElasticsearchImportRequest({
      connectionId: 'connection-1',
      index: 'logs',
      inputFile: '/tmp/logs.jsonl',
      batchSize: 500
    })
    expect(importResult.ok).toBe(true)
    if (importResult.ok) {
      expect(importResult.value.onConflict).toBe('skip')
    }

    const invalid = validateElasticsearchExportRequest({
      connectionId: '',
      index: '',
      outputFile: '',
      batchSize: 0,
      strategy: 'unsupported'
    })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) {
      expect(invalid.errors).toHaveLength(5)
    }
  })
})

describe('migration task validation', () => {
  it('accepts each supported task type with a valid payload', () => {
    const result = validateCreateMigrationTaskInput({
      type: 'elasticsearch-export',
      payload: {
        connectionId: 'connection-1',
        index: 'logs',
        outputFile: '/tmp/logs.jsonl',
        batchSize: 500,
        strategy: 'scroll'
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.type).toBe('elasticsearch-export')
      expect(result.value.payload).toMatchObject({ index: 'logs' })
    }
  })

  it('rejects invalid task types and payloads', () => {
    const invalidType = validateCreateMigrationTaskInput({
      type: 'mysql-export',
      payload: {}
    })
    expect(invalidType.ok).toBe(false)
    if (!invalidType.ok) {
      expect(invalidType.errors).toContain('任务类型无效')
    }

    const invalidPayload = validateCreateMigrationTaskInput({
      type: 'postgres-import',
      payload: {
        connectionId: '',
        table: { schema: '', name: '' },
        inputFile: '',
        batchSize: 0,
        onConflict: 'skip'
      }
    })
    expect(invalidPayload.ok).toBe(false)
  })
})

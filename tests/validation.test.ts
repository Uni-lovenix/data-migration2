import { describe, expect, it } from 'vitest'

import {
  defaultPortForType,
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

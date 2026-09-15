import { describe, expect, it } from 'vitest'

import {
  defaultPortForType,
  validateCreateMigrationTaskInput,
  validateElasticsearchExportRequest,
  validateElasticsearchImportRequest,
  validatePostgresBatchExportRequest,
  validatePostgresCountRowsRequest,
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

    const withDatabase = validatePostgresExportRequest({
      connectionId: 'connection-1',
      table: { schema: 'public', name: 'users' },
      outputFile: '/tmp/users.jsonl',
      batchSize: 500,
      database: 'analytics'
    })
    expect(withDatabase.ok).toBe(true)
    if (withDatabase.ok) {
      expect(withDatabase.value.database).toBe('analytics')
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

  it('accepts a multi-table export request and rejects empty selections', () => {
    const result = validatePostgresBatchExportRequest({
      connectionId: 'connection-1',
      tables: [
        { schema: 'public', name: 'users' },
        { schema: 'audit', name: 'events' }
      ],
      outputDirectory: '/tmp/export',
      batchSize: 500
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tables).toHaveLength(2)
    }

    const empty = validatePostgresBatchExportRequest({
      connectionId: 'connection-1',
      tables: [],
      outputDirectory: '',
      batchSize: 0
    })
    expect(empty.ok).toBe(false)
    if (!empty.ok) {
      expect(empty.errors).toContain('至少选择一张表')
      expect(empty.errors).toContain('导出目录不能为空')
    }

    const invalidDatabase = validatePostgresBatchExportRequest({
      connectionId: 'connection-1',
      tables: [{ schema: 'public', name: 'users' }],
      outputDirectory: '/tmp/export',
      batchSize: 500,
      database: '  '
    })
    expect(invalidDatabase.ok).toBe(false)
  })

  it('accepts a row count request with the selected database', () => {
    const result = validatePostgresCountRowsRequest({
      connectionId: 'connection-1',
      table: { schema: 'public', name: 'users' },
      database: 'analytics'
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.database).toBe('analytics')
    }
  })
})

describe('PostgreSQL WHERE clause validation', () => {
  it('accepts a valid WHERE predicate and trims whitespace', () => {
    const result = validatePostgresExportRequest({
      connectionId: 'connection-1',
      table: { schema: 'public', name: 'users' },
      outputFile: '/tmp/u.jsonl',
      batchSize: 500,
      where: '  active = true  '
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.where).toBe('active = true')
    }
  })

  it('drops empty or whitespace-only where from the payload', () => {
    const blank = validatePostgresExportRequest({
      connectionId: 'connection-1',
      table: { schema: 'public', name: 'users' },
      outputFile: '/tmp/u.jsonl',
      batchSize: 500,
      where: '   '
    })
    expect(blank.ok).toBe(true)
    if (blank.ok) {
      expect(blank.value.where).toBeUndefined()
    }

    const omitted = validatePostgresExportRequest({
      connectionId: 'connection-1',
      table: { schema: 'public', name: 'users' },
      outputFile: '/tmp/u.jsonl',
      batchSize: 500
    })
    expect(omitted.ok).toBe(true)
    if (omitted.ok) {
      expect('where' in omitted.value).toBe(false)
    }
  })

  it('rejects non-string where', () => {
    const result = validatePostgresExportRequest({
      connectionId: 'connection-1',
      table: { schema: 'public', name: 'users' },
      outputFile: '/tmp/u.jsonl',
      batchSize: 500,
      where: 42 as unknown as string
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('字符串')
    }
  })

  it('rejects a where clause containing ;', () => {
    const result = validatePostgresExportRequest({
      connectionId: 'connection-1',
      table: { schema: 'public', name: 'users' },
      outputFile: '/tmp/u.jsonl',
      batchSize: 500,
      where: 'id = 1; DROP TABLE users'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('分号')
    }
  })

  it('rejects a where clause containing --', () => {
    const result = validatePostgresExportRequest({
      connectionId: 'connection-1',
      table: { schema: 'public', name: 'users' },
      outputFile: '/tmp/u.jsonl',
      batchSize: 500,
      where: 'id = 1 -- sneak'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('注释')
    }
  })

  it('rejects where clauses longer than 4000 characters', () => {
    const long = "a = 'x'" + ' OR '.repeat(1000) + 'b = 1'
    const result = validatePostgresExportRequest({
      connectionId: 'connection-1',
      table: { schema: 'public', name: 'users' },
      outputFile: '/tmp/u.jsonl',
      batchSize: 500,
      where: long
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('4000')
    }
  })

  it('passes light validation through to PostgreSQL for fragments that look like SQL errors', () => {
    const result = validatePostgresExportRequest({
      connectionId: 'connection-1',
      table: { schema: 'public', name: 'users' },
      outputFile: '/tmp/u.jsonl',
      batchSize: 500,
      where: 'this is not sql'
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.where).toBe('this is not sql')
    }
  })

  it('validates where on the batch export request', () => {
    const ok = validatePostgresBatchExportRequest({
      connectionId: 'connection-1',
      tables: [{ schema: 'public', name: 'users' }],
      outputDirectory: '/tmp/x',
      batchSize: 500,
      where: "active = 't'"
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.value.where).toBe("active = 't'")
    }

    const bad = validatePostgresBatchExportRequest({
      connectionId: 'connection-1',
      tables: [{ schema: 'public', name: 'users' }],
      outputDirectory: '/tmp/x',
      batchSize: 500,
      where: 'bad; sql'
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.errors.join(' ')).toContain('分号')
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

  it('accepts and validates the query field on export', () => {
    const okResult = validateElasticsearchExportRequest({
      connectionId: 'connection-1',
      index: 'logs',
      outputFile: '/tmp/logs.jsonl',
      batchSize: 500,
      query: '{"range":{"ts":{"gte":"2024-01-01"}}}'
    })
    expect(okResult.ok).toBe(true)
    if (okResult.ok) {
      expect(okResult.value.query).toBe('{"range":{"ts":{"gte":"2024-01-01"}}}')
    }

    const emptyResult = validateElasticsearchExportRequest({
      connectionId: 'connection-1',
      index: 'logs',
      outputFile: '/tmp/logs.jsonl',
      batchSize: 500,
      query: '   '
    })
    expect(emptyResult.ok).toBe(true)
    if (emptyResult.ok) {
      expect(emptyResult.value.query).toBeUndefined()
    }

    const malformed = validateElasticsearchExportRequest({
      connectionId: 'connection-1',
      index: 'logs',
      outputFile: '/tmp/logs.jsonl',
      batchSize: 500,
      query: '{not json'
    })
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) {
      expect(malformed.errors.join(' ')).toContain('合法 JSON')
    }

    const nonObject = validateElasticsearchExportRequest({
      connectionId: 'connection-1',
      index: 'logs',
      outputFile: '/tmp/logs.jsonl',
      batchSize: 500,
      query: '["not","an","object"]'
    })
    expect(nonObject.ok).toBe(false)
    if (!nonObject.ok) {
      expect(nonObject.errors.join(' ')).toContain('对象')
    }
  })

  it('defaults exportMapping to true and honors explicit false', () => {
    const defaulted = validateElasticsearchExportRequest({
      connectionId: 'connection-1',
      index: 'logs',
      outputFile: '/tmp/logs.jsonl',
      batchSize: 500
    })
    expect(defaulted.ok).toBe(true)
    if (defaulted.ok) {
      expect(defaulted.value.exportMapping).toBe(true)
    }

    const disabled = validateElasticsearchExportRequest({
      connectionId: 'connection-1',
      index: 'logs',
      outputFile: '/tmp/logs.jsonl',
      batchSize: 500,
      exportMapping: false
    })
    expect(disabled.ok).toBe(true)
    if (disabled.ok) {
      expect(disabled.value.exportMapping).toBe(false)
    }
  })

  it('accepts inline and sidecar mapping on import', () => {
    const inline = validateElasticsearchImportRequest({
      connectionId: 'connection-1',
      index: 'logs',
      inputFile: '/tmp/logs.jsonl',
      batchSize: 500,
      onConflict: 'skip',
      createIndex: true,
      mapping: { source: 'inline', inlineJson: '{"mappings":{"properties":{"x":{"type":"keyword"}}}}' }
    })
    expect(inline.ok).toBe(true)
    if (inline.ok) {
      expect(inline.value.createIndex).toBe(true)
      expect(inline.value.mapping?.source).toBe('inline')
      expect(inline.value.mapping?.inlineJson).toContain('keyword')
    }

    const sidecar = validateElasticsearchImportRequest({
      connectionId: 'connection-1',
      index: 'logs',
      inputFile: '/tmp/logs.jsonl',
      batchSize: 500,
      onConflict: 'skip',
      createIndex: false,
      mapping: { source: 'sidecar', sidecarPath: '/tmp/logs.mapping.json' }
    })
    expect(sidecar.ok).toBe(true)
    if (sidecar.ok) {
      expect(sidecar.value.createIndex).toBe(false)
      expect(sidecar.value.mapping?.source).toBe('sidecar')
      expect(sidecar.value.mapping?.sidecarPath).toBe('/tmp/logs.mapping.json')
    }
  })

  it('defaults createIndex to true and accepts omitted mapping', () => {
    const result = validateElasticsearchImportRequest({
      connectionId: 'connection-1',
      index: 'logs',
      inputFile: '/tmp/logs.jsonl',
      batchSize: 500,
      onConflict: 'skip'
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.createIndex).toBe(true)
      expect(result.value.mapping).toBeUndefined()
    }
  })

  it('rejects malformed inline mapping JSON and missing source', () => {
    const malformed = validateElasticsearchImportRequest({
      connectionId: 'connection-1',
      index: 'logs',
      inputFile: '/tmp/logs.jsonl',
      batchSize: 500,
      onConflict: 'skip',
      mapping: { source: 'inline', inlineJson: '{not json' }
    })
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) {
      expect(malformed.errors.join(' ')).toContain('合法 JSON')
    }

    const inlineWithoutJson = validateElasticsearchImportRequest({
      connectionId: 'connection-1',
      index: 'logs',
      inputFile: '/tmp/logs.jsonl',
      batchSize: 500,
      onConflict: 'skip',
      mapping: { source: 'inline' }
    })
    expect(inlineWithoutJson.ok).toBe(false)
    if (!inlineWithoutJson.ok) {
      expect(inlineWithoutJson.errors.join(' ')).toContain('inlineJson')
    }

    const badSource = validateElasticsearchImportRequest({
      connectionId: 'connection-1',
      index: 'logs',
      inputFile: '/tmp/logs.jsonl',
      batchSize: 500,
      onConflict: 'skip',
      mapping: { source: 'nonsense' }
    })
    expect(badSource.ok).toBe(false)
    if (!badSource.ok) {
      expect(badSource.errors.join(' ')).toContain('source')
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

    const batchResult = validateCreateMigrationTaskInput({
      type: 'postgres-export-batch',
      payload: {
        connectionId: 'connection-1',
        tables: [{ schema: 'public', name: 'users' }],
        outputDirectory: '/tmp/export',
        batchSize: 500
      }
    })
    expect(batchResult.ok).toBe(true)
    if (batchResult.ok) {
      expect(batchResult.value.type).toBe('postgres-export-batch')
    }

    // MySQL 表单导出（schema 字段承载 database 名）：单表与批量两种任务类型。
    const mysqlResult = validateCreateMigrationTaskInput({
      type: 'mysql-export',
      payload: {
        connectionId: 'connection-1',
        table: { schema: 'app', name: 'users' },
        outputFile: '/tmp/app.users.jsonl',
        batchSize: 500,
        database: 'app'
      }
    })
    expect(mysqlResult.ok).toBe(true)
    if (mysqlResult.ok) {
      expect(mysqlResult.value.type).toBe('mysql-export')
      expect(mysqlResult.value.payload).toMatchObject({ database: 'app' })
    }

    const mysqlBatchResult = validateCreateMigrationTaskInput({
      type: 'mysql-export-batch',
      payload: {
        connectionId: 'connection-1',
        tables: [{ schema: 'app', name: 'users' }],
        outputDirectory: '/tmp/mysql-export',
        batchSize: 500,
        database: 'app'
      }
    })
    expect(mysqlBatchResult.ok).toBe(true)
    if (mysqlBatchResult.ok) {
      expect(mysqlBatchResult.value.type).toBe('mysql-export-batch')
    }
  })

  it('rejects invalid task types and payloads', () => {
    const invalidType = validateCreateMigrationTaskInput({
      type: 'oracle-export',
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

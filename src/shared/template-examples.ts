// Helpers shared between renderer and main process for building template UIs.
//
// Lives in `shared/` so the renderer can render example configs without
// having to call the main process — keeps the form responsive.

import type {
  ConnectionType,
  TemplateAction,
  TemplateEngine
} from './types'

/**
 * Map a template engine identifier to its underlying connection type so the
 * form can filter the connection dropdown by compatibility.
 */
export function engineToConnectionType(engine: TemplateEngine): ConnectionType {
  switch (engine) {
    case 'pgmigrator':
      return 'postgresql'
    case 'esmigrator':
      return 'elasticsearch'
    case 'mysqlmigrator':
      return 'mysql'
    case 'sqlitemigrator':
      return 'sqlite'
    case 'hivemigrator':
      return 'hive'
    case 'neo4jmigrator':
      return 'neo4j'
    case 'accessmigrator':
      return 'access'
  }
}

/**
 * Build a `{{TODAY}}`-aware example `configJson` for the given (engine, action).
 * Renderers display this in placeholders and the "insert example" button
 * drops it into the textarea.
 */
export function exampleConfigJson(
  engine: TemplateEngine,
  action: TemplateAction
): string {
  const examples: Record<string, string> = {
    'pgmigrator:export': [
      '{',
      '  "type": "postgres-export",',
      '  "table": { "schema": "public", "name": "users" },',
      '  "outputFile": "/data/exports/users-{{TODAY}}.jsonl",',
      '  "batchSize": 5000,',
      '  "database": "postgres",',
      "  \"where\": \"created_at >= NOW() - INTERVAL '7 days'\"",
      '}'
    ].join('\n'),
    'pgmigrator:import': [
      '{',
      '  "type": "postgres-import",',
      '  "table": { "schema": "public", "name": "users" },',
      '  "inputFile": "/data/import/users.jsonl",',
      '  "batchSize": 5000,',
      '  "onConflict": "skip",',
      '  "database": "postgres",',
      '  "selectedColumns": ["id", "name", "email", "tags", "created_at"],',
      '  "fieldTransforms": [',
      '    { "sourceColumn": "payload", "sourceType": "json", "targetType": "text", "strategy": "json" },',
      '    { "sourceColumn": "tags", "sourceType": "array<string>", "targetType": "text", "strategy": "cast", "options": { "arrayDelimiter": "," } },',
      '    { "sourceColumn": "created_at", "sourceType": "iso-string", "targetType": "timestamp", "strategy": "cast" }',
      '  ]',
      '}'
    ].join('\n'),
    'esmigrator:export': [
      '{',
      '  "type": "elasticsearch-export",',
      '  "index": "logs-{{TODAY}}",',
      '  "outputFile": "/data/exports/logs.jsonl",',
      '  "batchSize": 5000,',
      '  "concurrency": 4,',
      '  "strategy": "scroll",',
      '  "query": { "range": { "@timestamp": { "gte": "now-7d" } } },',
      '  "exportMapping": true',
      '}'
    ].join('\n'),
    'esmigrator:import': [
      '{',
      '  "type": "elasticsearch-import",',
      '  "index": "logs",',
      '  "inputFile": "/data/import/logs.jsonl",',
      '  "batchSize": 5000,',
      '  "concurrency": 4,',
      '  "onConflict": "skip",',
      '  "createIndex": true,',
      '  "mapping": { "source": "sidecar" },',
      '  "selectedColumns": ["@timestamp", "message", "level", "payload"],',
      '  "fieldTransforms": [',
      '    { "sourceColumn": "payload", "sourceType": "map<string,any>", "targetType": "text", "strategy": "cast" }',
      '  ]',
      '}'
    ].join('\n'),
    'mysqlmigrator:export': [
      '{',
      '  "type": "mysql-export",',
      '  "table": { "schema": "app", "name": "users" },',
      '  "database": "app",',
      '  "outputFile": "/data/exports/mysql-users.jsonl",',
      '  "batchSize": 5000',
      '}'
    ].join('\n'),
    'mysqlmigrator:import': [
      '{',
      '  "type": "mysql-import",',
      '  "table": { "schema": "app", "name": "users" },',
      '  "database": "app",',
      '  "inputFile": "/data/import/users.jsonl",',
      '  "batchSize": 5000,',
      '  "onConflict": "skip",',
      '  "selectedColumns": ["id", "name", "payload"],',
      '  "fieldTransforms": [',
      '    { "sourceColumn": "payload", "sourceType": "map<string,any>", "targetType": "text", "strategy": "json" }',
      '  ]',
      '}'
    ].join('\n'),
    'sqlitemigrator:export': [
      '{',
      '  "type": "sqlite-export",',
      '  "table": { "schema": "main", "name": "users" },',
      '  "outputFile": "/data/exports/sqlite-users.jsonl",',
      '  "batchSize": 5000',
      '}'
    ].join('\n'),
    'hivemigrator:export': [
      '{',
      '  "type": "hive-export",',
      '  "table": { "database": "default", "name": "events" },',
      '  "outputFile": "/data/exports/hive-events.jsonl",',
      '  "batchSize": 5000',
      '}'
    ].join('\n'),
    'hivemigrator:import': [
      '{',
      '  "type": "hive-import",',
      '  "table": { "database": "default", "name": "events" },',
      '  "inputFile": "/data/import/events.jsonl",',
      '  "batchSize": 5000,',
      '  "selectedColumns": ["id", "name", "payload"],',
      '  "fieldTransforms": [',
      '    { "sourceColumn": "payload", "sourceType": "map<string,any>", "targetType": "string", "strategy": "json" }',
      '  ]',
      '}'
    ].join('\n'),
    'neo4jmigrator:export': [
      '{',
      '  "type": "neo4j-export",',
      '  "kind": "node",',
      '  "name": "User",',
      '  "outputFile": "/data/exports/neo4j-user.jsonl",',
      '  "batchSize": 5000',
      '}'
    ].join('\n'),
    'accessmigrator:export': [
      '{',
      '  "type": "access-export",',
      '  "table": "Users",',
      '  "outputFile": "/data/exports/access-users.jsonl",',
      '  "batchSize": 5000',
      '}'
    ].join('\n')
  }
  const example = examples[`${engine}:${action}`]
  if (!example) {
    throw new Error(`${ENGINE_LABELS[engine]} 不支持${ACTION_LABELS[action]}模板`)
  }
  return example
}

export const ACTION_LABELS: Record<TemplateAction, string> = {
  export: '导出',
  import: '导入'
}

export const ENGINE_LABELS: Record<TemplateEngine, string> = {
  pgmigrator: 'PostgreSQL',
  esmigrator: 'Elasticsearch',
  mysqlmigrator: 'MySQL',
  sqlitemigrator: 'SQLite',
  hivemigrator: 'Hive',
  neo4jmigrator: 'Neo4j',
  accessmigrator: 'Access'
}

export const TEMPLATE_ENGINE_ACTIONS: Record<TemplateEngine, TemplateAction[]> = {
  pgmigrator: ['export', 'import'],
  esmigrator: ['export', 'import'],
  mysqlmigrator: ['export', 'import'],
  sqlitemigrator: ['export'],
  hivemigrator: ['export', 'import'],
  neo4jmigrator: ['export'],
  accessmigrator: ['export']
}

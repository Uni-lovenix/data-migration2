// Helpers shared between renderer and main process for building template UIs.
//
// Lives in `shared/` so the renderer can render example configs without
// having to call the main process — keeps the form responsive.

import type { ConnectionType } from './types'

/**
 * Map a template engine identifier to its underlying connection type so the
 * form can filter the connection dropdown by compatibility.
 */
export function engineToConnectionType(
  engine: 'pgmigrator' | 'esmigrator'
): ConnectionType {
  return engine === 'pgmigrator' ? 'postgresql' : 'elasticsearch'
}

/**
 * Build a `{{TODAY}}`-aware example `configJson` for the given (engine, action).
 * Renderers display this in placeholders and the "insert example" button
 * drops it into the textarea.
 */
export function exampleConfigJson(
  engine: 'pgmigrator' | 'esmigrator',
  action: 'export' | 'import'
): string {
  if (engine === 'pgmigrator' && action === 'export') {
    return [
      '{',
      '  "type": "postgres-export",',
      '  "table": { "schema": "public", "name": "users" },',
      '  "outputFile": "/data/exports/users-{{TODAY}}.jsonl",',
      '  "batchSize": 5000,',
      '  "database": "postgres",',
      "  \"where\": \"created_at >= NOW() - INTERVAL '7 days'\"",
      '}'
    ].join('\n')
  }
  if (engine === 'pgmigrator' && action === 'import') {
    return [
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
    ].join('\n')
  }
  if (engine === 'esmigrator' && action === 'export') {
    return [
      '{',
      '  "type": "elasticsearch-export",',
      '  "index": "logs-{{TODAY}}",',
      '  "outputFile": "/data/exports/logs.jsonl",',
      '  "batchSize": 5000,',
      '  "strategy": "scroll",',
      '  "query": { "range": { "@timestamp": { "gte": "now-7d" } } },',
      '  "exportMapping": true',
      '}'
    ].join('\n')
  }
  return [
    '{',
    '  "type": "elasticsearch-import",',
    '  "index": "logs",',
    '  "inputFile": "/data/import/logs.jsonl",',
    '  "batchSize": 5000,',
    '  "onConflict": "skip",',
    '  "createIndex": true,',
    '  "mapping": { "source": "sidecar" },',
    '  "selectedColumns": ["@timestamp", "message", "level", "payload"],',
    '  "fieldTransforms": [',
    '    { "sourceColumn": "payload", "sourceType": "map<string,any>", "targetType": "text", "strategy": "cast" }',
    '  ]',
    '}'
  ].join('\n')
}

/**
 * All known canonical task types for each (engine, action) pair. Renderers use
 * this to display the right label in the connection dropdown helper text.
 */
export const ACTION_LABELS: Record<'export' | 'import', string> = {
  export: '导出',
  import: '导入'
}

export const ENGINE_LABELS: Record<'pgmigrator' | 'esmigrator', string> = {
  pgmigrator: 'PostgreSQL',
  esmigrator: 'Elasticsearch'
}

import type {
  MigrationTaskType,
  TemplateAction,
  TemplateEngine
} from './types'

export function engineActionToTaskType(
  engine: TemplateEngine,
  action: TemplateAction
): MigrationTaskType {
  if (engine === 'pgmigrator' && action === 'export') return 'postgres-export'
  if (engine === 'pgmigrator' && action === 'import') return 'postgres-import'
  if (engine === 'esmigrator' && action === 'export') return 'elasticsearch-export'
  if (engine === 'esmigrator' && action === 'import') return 'elasticsearch-import'
  if (engine === 'mysqlmigrator' && action === 'export') return 'mysql-export'
  if (engine === 'mysqlmigrator' && action === 'import') return 'mysql-import'
  if (engine === 'sqlitemigrator' && action === 'export') return 'sqlite-export'
  if (engine === 'hivemigrator' && action === 'export') return 'hive-export'
  if (engine === 'hivemigrator' && action === 'import') return 'hive-import'
  if (engine === 'neo4jmigrator' && action === 'export') return 'neo4j-export'
  if (engine === 'accessmigrator' && action === 'export') return 'access-export'
  throw new Error(`不支持的模板操作：${engine}/${action}`)
}

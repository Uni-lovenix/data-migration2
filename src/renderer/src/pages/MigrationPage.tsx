import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  ArrowRightLeft,
  CheckSquare,
  CheckCircle2,
  Database,
  FileJson,
  FolderOpen,
  FolderOutput,
  HardDriveDownload,
  HardDriveUpload,
  ListChecks,
  Loader2,
  PlugZap,
  RefreshCw,
  Search,
  SearchCheck,
  Square,
  Table2,
  XCircle
} from 'lucide-react'

import type {
  ConnectionConfig,
  FieldTransform,
  PostgresConflictAction,
  PostgresConnectionTestResult,
  PostgresBatchExportRequest,
  PostgresExportRequest,
  PostgresImportRequest,
  PostgresMigrationResult,
  PostgresTable,
  ViewKey
} from '../../../shared/types'
import { AccessMigrationPanel } from './AccessMigrationPanel'
import {
  validatePostgresBatchExportRequest,
  validatePostgresExportRequest,
  validatePostgresImportRequest
} from '../../../shared/validation'
import { ElasticsearchMigrationPanel } from './ElasticsearchMigrationPanel'
import { HiveMigrationPanel } from './HiveMigrationPanel'
import { MySQLMigrationPanel } from './MySQLMigrationPanel'
import { Neo4jMigrationPanel } from './Neo4jMigrationPanel'
import { SQLiteMigrationPanel } from './SQLiteMigrationPanel'
import { ColumnSelection } from '../components/ColumnSelection'
import { FieldTransformsEditor } from '../components/FieldTransformsEditor'

interface MigrationPageProps {
  connections: ConnectionConfig[]
  onNavigate: (view: ViewKey) => void
}

type MigrationMode = 'export' | 'import'
type MigrationEngine =
  | 'postgresql'
  | 'elasticsearch'
  | 'mysql'
  | 'sqlite'
  | 'hive'
  | 'access'
  | 'neo4j'

export function MigrationPage({
  connections,
  onNavigate
}: MigrationPageProps): ReactElement {
  const postgresConnections = useMemo(
    () => connections.filter((connection) => connection.type === 'postgresql'),
    [connections]
  )
  const [engine, setEngine] = useState<MigrationEngine>('postgresql')
  const [mode, setMode] = useState<MigrationMode>('export')
  const [connectionId, setConnectionId] = useState('')
  const [databases, setDatabases] = useState<string[]>([])
  const [database, setDatabase] = useState('')
  const [tables, setTables] = useState<PostgresTable[]>([])
  const [tableSearch, setTableSearch] = useState('')
  const [selectedTableKeys, setSelectedTableKeys] = useState<string[]>([])
  const [tableKey, setTableKey] = useState('')
  const [tableRowCounts, setTableRowCounts] = useState<Record<string, number>>({})
  const [pendingRowCounts, setPendingRowCounts] = useState<Record<string, boolean>>({})
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<PostgresConnectionTestResult | null>(null)
  const [loadingTables, setLoadingTables] = useState(false)
  const [filePath, setFilePath] = useState('')
  const [exportDirectory, setExportDirectory] = useState('')
  const [batchSize, setBatchSize] = useState('500')
  const [whereClause, setWhereClause] = useState('')
  const [onConflict, setOnConflict] = useState<PostgresConflictAction>('skip')
  const [selectedColumns, setSelectedColumns] = useState<string[]>([])
  const [fieldTransforms, setFieldTransforms] = useState<FieldTransform[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PostgresMigrationResult | null>(null)
  const rowCountRequestId = useRef(0)

  const selectedConnection =
    postgresConnections.find((connection) => connection.id === connectionId) ?? null
  const selectedTables = useMemo(
    () =>
      tables.filter((table) =>
        selectedTableKeys.includes(tableKeyFor(table))
      ),
    [tables, selectedTableKeys]
  )
  const selectedTable =
    tables.find((table) => tableKeyFor(table) === tableKey) ?? null
  const visibleTables = useMemo(() => {
    const keyword = tableSearch.trim().toLowerCase()
    const filtered =
      keyword.length > 0
        ? tables.filter((table) =>
            `${table.schema}.${table.name}`.toLowerCase().includes(keyword)
          )
        : tables
    return filtered.slice(0, 500)
  }, [tables, tableSearch])

  useEffect(() => {
    return () => {
      rowCountRequestId.current += 1
    }
  }, [])

  function startRowCounts(
    targetTables: PostgresTable[],
    targetConnectionId: string,
    targetDatabase: string
  ): void {
    const requestId = rowCountRequestId.current + 1
    rowCountRequestId.current = requestId
    setTableRowCounts({})

    if (targetTables.length === 0) {
      setPendingRowCounts({})
      return
    }

    const pending: Record<string, boolean> = {}
    for (const table of targetTables) {
      pending[tableKeyFor(table)] = true
    }
    setPendingRowCounts(pending)

    const queue = [...targetTables]
    const workerCount = Math.min(4, queue.length)
    const workers = Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const table = queue.shift()
        if (!table) {
          continue
        }
        const key = tableKeyFor(table)
        try {
          const count = await window.api.postgres.countRows({
            connectionId: targetConnectionId,
            database: targetDatabase,
            table: { schema: table.schema, name: table.name }
          })
          if (rowCountRequestId.current !== requestId) {
            return
          }
          setTableRowCounts((current) => ({ ...current, [key]: count }))
        } catch {
          // A failed count keeps the estimated row count fallback.
        } finally {
          if (rowCountRequestId.current === requestId) {
            setPendingRowCounts((current) => ({ ...current, [key]: false }))
          }
        }
      }
    })
    void Promise.all(workers)
  }

  function rowCountLabel(table: PostgresTable): string {
    const key = tableKeyFor(table)
    if (pendingRowCounts[key]) {
      return '...'
    }
    const count = tableRowCounts[key]
    if (count !== undefined) {
      return `${count.toLocaleString()} 行`
    }
    if (table.estimatedRows === null) {
      return '行数未知'
    }
    return `${table.estimatedRows.toLocaleString()} 行`
  }

  useEffect(() => {
    if (!connectionId) {
      setDatabases([])
      setDatabase('')
      setTables([])
      setSelectedTableKeys([])
      setTableKey('')
      return
    }

    let disposed = false
    setLoadingTables(true)
    setError(null)
    const selected = postgresConnections.find(
      (connection) => connection.id === connectionId
    )
    if (typeof window.api.postgres.databases !== 'function') {
      setDatabase((current) => current || selected?.database || 'postgres')
      setLoadingTables(false)
      return
    }
    window.api.postgres
      .databases(connectionId)
      .then((nextDatabases) => {
        if (disposed) {
          return
        }
        setDatabases(nextDatabases)
        const fallback =
          selected?.database && nextDatabases.includes(selected.database)
            ? selected.database
            : nextDatabases[0] ?? selected?.database ?? 'postgres'
        setDatabase((current) =>
          current && nextDatabases.includes(current) ? current : fallback
        )
      })
      .catch((cause) => {
        if (!disposed) {
          setDatabase((current) => current || selected?.database || 'postgres')
          setError(errorMessage(cause))
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoadingTables(false)
        }
      })

    return () => {
      disposed = true
    }
  }, [connectionId, postgresConnections])

  useEffect(() => {
    if (!connectionId || !database) {
      return
    }

    let disposed = false
    setLoadingTables(true)
    setError(null)
    window.api.postgres
      .tables(connectionId, database)
      .then((nextTables) => {
        if (disposed) {
          return
        }
        setTables(nextTables)
        const firstKey = nextTables[0] ? tableKeyFor(nextTables[0]) : ''
        const availableKeys = new Set(nextTables.map(tableKeyFor))
        setSelectedTableKeys((current) => {
          const kept = current.filter((key) => availableKeys.has(key))
          return kept.length > 0 ? kept : firstKey ? [firstKey] : []
        })
        setTableKey((current) => (availableKeys.has(current) ? current : firstKey))
        void startRowCounts(nextTables, connectionId, database)
      })
      .catch((cause) => {
        if (!disposed) {
          setError(errorMessage(cause))
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoadingTables(false)
        }
      })

    return () => {
      disposed = true
    }
  }, [connectionId, database])

  function changeMode(nextMode: MigrationMode): void {
    setMode(nextMode)
    setFilePath('')
    setExportDirectory('')
    setWhereClause('')
    setResult(null)
    setError(null)
    setSelectedColumns([])
    setFieldTransforms([])
    if (nextMode === 'import') {
      setTableKey((current) => current || (selectedTableKeys[0] ?? ''))
    }
  }

  function selectConnection(nextConnectionId: string): void {
    setConnectionId(nextConnectionId)
    setDatabases([])
    setDatabase('')
    setTables([])
    setTableSearch('')
    setSelectedTableKeys([])
    setTableKey('')
    setFilePath('')
    setExportDirectory('')
    setWhereClause('')
    setTableRowCounts({})
    setPendingRowCounts({})
    setTestResult(null)
    setResult(null)
    setError(null)
    setSelectedColumns([])
    setFieldTransforms([])
  }

  function selectDatabase(nextDatabase: string): void {
    setDatabase(nextDatabase)
    setTables([])
    setTableSearch('')
    setSelectedTableKeys([])
    setTableKey('')
    setFilePath('')
    setExportDirectory('')
    setWhereClause('')
    setTableRowCounts({})
    setPendingRowCounts({})
    setResult(null)
    setError(null)
    setSelectedColumns([])
    setFieldTransforms([])
  }

  async function handleTest(): Promise<void> {
    if (!selectedConnection) {
      setError('请先选择连接')
      return
    }
    setTesting(true)
    setTestResult(null)
    setError(null)
    try {
      const test = await window.api.postgres.test(selectedConnection.id, database)
      setTestResult(test)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setTesting(false)
    }
  }

  async function handleLoadTables(): Promise<void> {
    if (!selectedConnection) {
      setError('请先选择连接')
      return
    }
    setLoadingTables(true)
    setError(null)
    try {
      const nextTables = await window.api.postgres.tables(
        selectedConnection.id,
        database
      )
      setTables(nextTables)
      const firstKey = nextTables[0] ? tableKeyFor(nextTables[0]) : ''
      const availableKeys = new Set(nextTables.map(tableKeyFor))
      setSelectedTableKeys((current) => {
        const kept = current.filter((key) => availableKeys.has(key))
        return kept.length > 0 ? kept : firstKey ? [firstKey] : []
      })
      setTableKey((current) => (availableKeys.has(current) ? current : firstKey))
      void startRowCounts(nextTables, selectedConnection.id, database)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoadingTables(false)
    }
  }

  function toggleTable(key: string): void {
    setSelectedTableKeys((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key]
    )
    setFilePath('')
    setExportDirectory('')
    setResult(null)
    setSelectedColumns([])
    setFieldTransforms([])
  }

  function selectAllTables(): void {
    setSelectedTableKeys(tables.map(tableKeyFor))
    setFilePath('')
    setExportDirectory('')
    setResult(null)
  }

  function clearTableSelection(): void {
    setSelectedTableKeys([])
    setFilePath('')
    setExportDirectory('')
    setResult(null)
  }

  async function handleChooseFile(): Promise<void> {
    try {
      if (mode === 'export') {
        if (selectedTables.length > 1) {
          const directory = await window.api.dialog.chooseExportDirectory()
          if (directory) {
            setExportDirectory(directory)
          }
          setError(null)
          return
        }
        const suggestedName = selectedTables[0]
          ? `${selectedTables[0].schema}.${selectedTables[0].name}.jsonl`
          : 'postgres-export.jsonl'
        const path = await window.api.dialog.chooseExportFile(suggestedName)
        if (path) {
          setFilePath(path)
        }
      } else {
        const path = await window.api.dialog.chooseImportFile()
        if (path) {
          setFilePath(path)
        }
      }
      setError(null)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function handleStart(): Promise<void> {
    const parsedBatchSize = Number(batchSize)
    const trimmedWhere = whereClause.trim()
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      if (mode === 'import') {
        const table = selectedTable
          ? { schema: selectedTable.schema, name: selectedTable.name }
          : null
        const request: PostgresImportRequest = {
          connectionId,
          table: table ?? { schema: '', name: '' },
          inputFile: filePath,
          batchSize: parsedBatchSize,
          onConflict,
          database,
          ...(selectedColumns.length > 0 ? { selectedColumns } : {}),
          ...(fieldTransforms.length > 0 ? { fieldTransforms } : {})
        }
        const validation = validatePostgresImportRequest(request)
        if (!validation.ok) {
          setError(validation.errors.join('；'))
          return
        }
        await window.api.tasks.create({
          type: 'postgres-import',
          payload: validation.value
        })
      } else if (selectedTables.length === 1) {
        const selected = selectedTables[0]
        if (!selected) {
          setError('请选择一张表')
          return
        }
        const request: PostgresExportRequest = {
          connectionId,
          table: { schema: selected.schema, name: selected.name },
          outputFile: filePath,
          batchSize: parsedBatchSize,
          database,
          ...(trimmedWhere.length > 0 ? { where: trimmedWhere } : {})
        }
        const validation = validatePostgresExportRequest(request)
        if (!validation.ok) {
          setError(validation.errors.join('；'))
          return
        }
        await window.api.tasks.create({
          type: 'postgres-export',
          payload: validation.value
        })
      } else {
        if (selectedTables.length === 0) {
          setError('请至少选择一张表')
          return
        }
        const request: PostgresBatchExportRequest = {
          connectionId,
          tables: selectedTables.map((table) => ({
            schema: table.schema,
            name: table.name
          })),
          outputDirectory: exportDirectory,
          batchSize: parsedBatchSize,
          database,
          ...(trimmedWhere.length > 0 ? { where: trimmedWhere } : {})
        }
        const validation = validatePostgresBatchExportRequest(request)
        if (!validation.ok) {
          setError(validation.errors.join('；'))
          return
        }
        await window.api.tasks.create({
          type: 'postgres-export-batch',
          payload: validation.value
        })
      }
      onNavigate('tasks')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>{ENGINE_HEADINGS[engine].title}</h1>
          <p>{ENGINE_HEADINGS[engine].subtitle}</p>
        </div>
        <div className="segmented">
          <button
            type="button"
            className={engine === 'postgresql' ? 'segment segment-active' : 'segment'}
            onClick={() => setEngine('postgresql')}
          >
            <Database size={15} />
            PostgreSQL
          </button>
          <button
            type="button"
            className={engine === 'elasticsearch' ? 'segment segment-active' : 'segment'}
            onClick={() => setEngine('elasticsearch')}
          >
            <SearchCheck size={15} />
            Elasticsearch
          </button>
          <button
            type="button"
            className={engine === 'mysql' ? 'segment segment-active' : 'segment'}
            onClick={() => setEngine('mysql')}
          >
            <Database size={15} />
            MySQL
          </button>
          <button
            type="button"
            className={engine === 'sqlite' ? 'segment segment-active' : 'segment'}
            onClick={() => setEngine('sqlite')}
          >
            <HardDriveDownload size={15} />
            SQLite
          </button>
          <button
            type="button"
            className={engine === 'hive' ? 'segment segment-active' : 'segment'}
            onClick={() => setEngine('hive')}
          >
            <Database size={15} />
            Hive
          </button>
          <button
            type="button"
            className={engine === 'neo4j' ? 'segment segment-active' : 'segment'}
            onClick={() => setEngine('neo4j')}
          >
            <Database size={15} />
            Neo4j
          </button>
          <button
            type="button"
            className={engine === 'access' ? 'segment segment-active' : 'segment'}
            onClick={() => setEngine('access')}
          >
            <HardDriveDownload size={15} />
            Access
          </button>
        </div>
      </div>

      {engine === 'elasticsearch' ? (
        <ElasticsearchMigrationPanel
          connections={connections}
          onNavigate={onNavigate}
        />
      ) : engine === 'mysql' ? (
        <MySQLMigrationPanel connections={connections} onNavigate={onNavigate} />
      ) : engine === 'sqlite' ? (
        <SQLiteMigrationPanel connections={connections} onNavigate={onNavigate} />
      ) : engine === 'hive' ? (
        <HiveMigrationPanel connections={connections} onNavigate={onNavigate} />
      ) : engine === 'neo4j' ? (
        <Neo4jMigrationPanel connections={connections} onNavigate={onNavigate} />
      ) : engine === 'access' ? (
        <AccessMigrationPanel connections={connections} onNavigate={onNavigate} />
      ) : (
        <>
          {postgresConnections.length === 0 ? (
            <div className="empty-state">
              <Database size={30} />
              <span>还没有 PostgreSQL 连接</span>
              <button
                type="button"
                className="button button-primary"
                onClick={() => onNavigate('connections')}
              >
                管理连接
              </button>
            </div>
          ) : (
            <>
              <div className="toolbar">
                <div className="segmented">
                  <button
                    type="button"
                    className={mode === 'export' ? 'segment segment-active' : 'segment'}
                    onClick={() => changeMode('export')}
                  >
                    <HardDriveDownload size={15} />
                    导出
                  </button>
                  <button
                    type="button"
                    className={mode === 'import' ? 'segment segment-active' : 'segment'}
                    onClick={() => changeMode('import')}
                  >
                    <HardDriveUpload size={15} />
                    导入
                  </button>
                </div>
                <span className="badge">{mode === 'export' ? '表 → 文件' : '文件 → 表'}</span>
              </div>

              <div className="migration-grid">
                <section className="section migration-section">
                  <div className="section-heading">
                    <h2>连接与表</h2>
                    <span className="badge">PostgreSQL</span>
                  </div>
                  <div className="migration-body">
                    <div className="field-grid">
                      <div className="field">
                        <label htmlFor="migration-connection">连接</label>
                        <select
                          id="migration-connection"
                          value={connectionId}
                          onChange={(event) => selectConnection(event.target.value)}
                        >
                          <option value="">选择连接</option>
                          {postgresConnections.map((connection) => (
                            <option key={connection.id} value={connection.id}>
                              {connection.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label>连接状态</label>
                        <div className="field-row">
                          <button
                            type="button"
                            className="button button-secondary"
                            disabled={!selectedConnection || testing}
                            onClick={() => void handleTest()}
                          >
                            {testing ? <Loader2 className="spin" size={15} /> : <PlugZap size={15} />}
                            测试连接
                          </button>
                          {testResult ? (
                            <span
                              className={`badge ${testResult.ok ? 'badge-ok' : 'badge-error'}`}
                              title={testResult.message}
                            >
                              {testResult.ok
                                ? `已连接 ${testResult.serverVersion ?? ''}`
                                : testResult.message ?? '连接失败'}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    <div className="field">
                      <label htmlFor="migration-database">数据库</label>
                      <select
                        id="migration-database"
                        value={database}
                        disabled={
                          !selectedConnection ||
                          (databases.length === 0 && !database)
                        }
                        onChange={(event) => selectDatabase(event.target.value)}
                      >
                        {database && !databases.includes(database) ? (
                          <option value={database}>{database}</option>
                        ) : null}
                        {databases.length === 0 ? (
                          <option value="">加载数据库</option>
                        ) : (
                          databases.map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))
                        )}
                      </select>
                    </div>

                    <div className="field">
                      <label htmlFor="migration-table">
                        {mode === 'export' ? '表' : '目标表'}
                      </label>
                      {mode === 'export' ? (
                        <div className="table-picker-wrap">
                          <div className="search-box table-search">
                            <Search size={14} />
                            <input
                              value={tableSearch}
                              onChange={(event) => setTableSearch(event.target.value)}
                              placeholder="搜索表名"
                              aria-label="搜索表名"
                            />
                          </div>
                          <div className="table-picker">
                            {!connectionId ? (
                              <div className="table-picker-empty">请先选择连接</div>
                            ) : !database ? (
                              <div className="table-picker-empty">请选择数据库</div>
                            ) : loadingTables ? (
                              <div className="table-picker-empty table-picker-loading">
                                <Loader2 className="spin" size={14} />
                                正在加载表…
                              </div>
                            ) : tables.length === 0 ? (
                              <div className="table-picker-empty">
                                当前数据库没有可导出的表
                              </div>
                            ) : visibleTables.length === 0 ? (
                              <div className="table-picker-empty">没有匹配的表</div>
                            ) : (
                              visibleTables.map((table) => {
                                const key = tableKeyFor(table)
                                return (
                                  <label
                                    key={key}
                                    className="table-picker-row"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={selectedTableKeys.includes(key)}
                                      onChange={() => toggleTable(key)}
                                    />
                                    <span className="table-picker-name">
                                      {`${table.schema}.${table.name}`}
                                    </span>
                                    <span className="badge">{table.columns.length} 列</span>
                                    <span className="badge">{rowCountLabel(table)}</span>
                                  </label>
                                )
                              })
                            )}
                          </div>
                          <div className="table-picker-actions">
                            <button
                              type="button"
                              className="button button-secondary button-small"
                              disabled={tables.length === 0}
                              onClick={selectAllTables}
                            >
                              <CheckSquare size={14} />
                              全选
                            </button>
                            <button
                              type="button"
                              className="button button-secondary button-small"
                              disabled={selectedTableKeys.length === 0}
                              onClick={clearTableSelection}
                            >
                              <Square size={14} />
                              清空
                            </button>
                            <button
                              type="button"
                              className="button button-secondary button-small"
                              disabled={!selectedConnection || !database || loadingTables}
                              onClick={() => void handleLoadTables()}
                            >
                              {loadingTables ? (
                                <Loader2 className="spin" size={14} />
                              ) : (
                                <RefreshCw size={14} />
                              )}
                              刷新
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="field-row">
                          <select
                            id="migration-table"
                            value={tableKey}
                            disabled={tables.length === 0}
                            onChange={(event) => setTableKey(event.target.value)}
                          >
                            {tables.length === 0 ? (
                              <option value="">
                                {!connectionId || !database
                                  ? '请先选择连接和数据库'
                                  : loadingTables
                                    ? '正在加载表…'
                                    : '当前数据库没有可导入的表'}
                              </option>
                            ) : (
                              tables.map((table) => (
                                <option key={tableKeyFor(table)} value={tableKeyFor(table)}>
                                  {`${table.schema}.${table.name}`}
                                </option>
                              ))
                            )}
                          </select>
                          <button
                            type="button"
                            className="button button-secondary"
                            disabled={!selectedConnection || !database || loadingTables}
                            onClick={() => void handleLoadTables()}
                          >
                            {loadingTables ? (
                              <Loader2 className="spin" size={15} />
                            ) : (
                              <RefreshCw size={15} />
                            )}
                            加载表
                          </button>
                        </div>
                      )}
                    </div>

                    {mode === 'export' && selectedTables.length > 0 ? (
                      <div className="table-summary">
                        <span className="table-summary-icon">
                          <ListChecks size={16} />
                        </span>
                        <span className="badge">{selectedTables.length} 张表</span>
                        {selectedTables.length === 1 && selectedTables[0] ? (
                          <>
                            <span className="badge">{selectedTables[0].columns.length} 列</span>
                            <span className="badge">{rowCountLabel(selectedTables[0])}</span>
                          </>
                        ) : null}
                      </div>
                    ) : selectedTable ? (
                      <div className="table-summary">
                        <span className="table-summary-icon">
                          <Table2 size={16} />
                        </span>
                        <span className="badge">{selectedTable.columns.length} 列</span>
                        <span className="badge">{rowCountLabel(selectedTable)}</span>
                        {selectedTable.columns.some((column) => column.isPrimaryKey) ? (
                          <span className="badge">有主键</span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </section>

                <section className="section migration-section">
                  <div className="section-heading">
                    <h2>文件与选项</h2>
                    <span className="badge">批量</span>
                  </div>
                  <div className="migration-body">
                    <div className="field">
                      <label>
                        {mode === 'export'
                          ? selectedTables.length > 1
                            ? '导出目录'
                            : '导出文件'
                          : '导入文件'}
                      </label>
                      <div className="file-picker">
                        <input
                          className="file-path"
                          value={mode === 'export' && selectedTables.length > 1 ? exportDirectory : filePath}
                          readOnly
                          placeholder={
                            mode === 'export'
                              ? selectedTables.length > 1
                                ? '选择导出目录'
                                : '选择输出文件'
                              : '选择 JSONL 文件'
                          }
                        />
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => void handleChooseFile()}
                        >
                          {mode === 'export' && selectedTables.length > 1 ? (
                            <FolderOutput size={15} />
                          ) : (
                            <FolderOpen size={15} />
                          )}
                          {mode === 'export' && selectedTables.length > 1
                            ? '选择目录'
                            : '选择文件'}
                        </button>
                      </div>
                    </div>

                    <div className="field-grid">
                      <div className="field">
                        <label htmlFor="migration-batch-size">批量大小</label>
                        <input
                          id="migration-batch-size"
                          type="number"
                          min={1}
                          max={10000}
                          value={batchSize}
                          onChange={(event) => setBatchSize(event.target.value)}
                        />
                      </div>
                      {mode === 'import' ? (
                        <div className="field">
                          <label>冲突处理</label>
                          <div className="segmented">
                            <button
                              type="button"
                              className={onConflict === 'skip' ? 'segment segment-active' : 'segment'}
                              onClick={() => setOnConflict('skip')}
                            >
                              跳过
                            </button>
                            <button
                              type="button"
                              className={onConflict === 'error' ? 'segment segment-active' : 'segment'}
                              onClick={() => setOnConflict('error')}
                            >
                              报错
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>

                    {mode === 'export' ? (
                      <div className="field">
                        <label htmlFor="migration-where">
                          SQL 条件 (WHERE)
                          <span className="hint">
                            留空 = 导出全表；不要包含 WHERE 关键字；会附加到所有选中表
                          </span>
                        </label>
                        <textarea
                          id="migration-where"
                          className="code-textarea"
                          rows={4}
                          placeholder={`created_at >= NOW() - INTERVAL '7 days' AND status = 'active'`}
                          value={whereClause}
                          onChange={(event) => setWhereClause(event.target.value)}
                        />
                      </div>
                    ) : null}

                    {mode === 'import' ? (
                      <>
                        <ColumnSelection
                          inputFile={filePath}
                          selectedColumns={selectedColumns}
                          onChange={setSelectedColumns}
                        />
                        <FieldTransformsEditor
                          inputFile={filePath}
                          transforms={fieldTransforms}
                          onChange={setFieldTransforms}
                        />
                      </>
                    ) : null}

                    <div className="migration-action-row">
                      <button
                        type="button"
                        className="button button-primary"
                        disabled={
                          running ||
                          !selectedConnection ||
                          !database ||
                          (mode === 'import'
                            ? !selectedTable || !filePath
                            : selectedTables.length === 0 ||
                              (selectedTables.length === 1
                                ? !filePath
                                : !exportDirectory))
                        }
                        onClick={() => void handleStart()}
                      >
                        {running ? (
                          <Loader2 className="spin" size={16} />
                        ) : mode === 'export' ? (
                          <HardDriveDownload size={16} />
                        ) : (
                          <HardDriveUpload size={16} />
                        )}
                        {mode === 'export' ? '开始导出' : '开始导入'}
                      </button>
                      <span className="badge">
                        {mode === 'export' ? <FileJson size={13} /> : <ArrowRightLeft size={13} />}
                        {batchSize ? `每批 ${batchSize} 行` : '每批 500 行'}
                      </span>
                    </div>
                  </div>
                </section>
              </div>

              {error ? <div className="inline-error">{error}</div> : null}

              {result ? (
                <section className="section result-section">
                  <div className="section-heading">
                    <h2>迁移结果</h2>
                    <span className="badge badge-ok">完成</span>
                  </div>
                  <div className="result-grid">
                    <div className="result-item">
                      <CheckCircle2 size={18} />
                      <div>
                        <strong>{result.rows.toLocaleString()}</strong>
                        <span>行</span>
                      </div>
                    </div>
                    <div className="result-item">
                      <XCircle size={18} />
                      <div>
                        <strong>{formatDuration(result.durationMs)}</strong>
                        <span>耗时</span>
                      </div>
                    </div>
                    {result.bytes !== undefined ? (
                      <div className="result-item">
                        <FileJson size={18} />
                        <div>
                          <strong>{formatBytes(result.bytes)}</strong>
                          <span>文件</span>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </section>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  )
}

const ENGINE_HEADINGS: Record<MigrationEngine, { title: string; subtitle: string }> = {
  postgresql: { title: 'PostgreSQL 迁移', subtitle: '表数据导出与导入' },
  elasticsearch: { title: 'Elasticsearch 迁移', subtitle: '索引文档导出与导入' },
  mysql: { title: 'MySQL 迁移', subtitle: '表数据导出到 JSONL' },
  sqlite: { title: 'SQLite 迁移', subtitle: '本地数据库表导出到 JSONL' },
  hive: { title: 'Hive 迁移', subtitle: '数据仓库表导出到 JSONL' },
  neo4j: { title: 'Neo4j 迁移', subtitle: '节点与关系导出到 JSONL' },
  access: { title: 'Access 迁移', subtitle: '本地 Access 表导出到 JSONL' }
}

function tableKeyFor(table: PostgresTable): string {
  return `${table.schema}.${table.name}`
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`
  }
  return `${(durationMs / 1000).toFixed(2)} s`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '迁移操作失败'
}

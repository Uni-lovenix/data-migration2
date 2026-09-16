import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  CheckSquare,
  Database,
  FileInput,
  FileJson,
  FolderOpen,
  FolderOutput,
  HardDriveDownload,
  ListChecks,
  Loader2,
  PlugZap,
  RefreshCw,
  Search,
  Square,
  Table2
} from 'lucide-react'

import type {
  ConnectionConfig,
  MySQLBatchExportRequest,
  MySQLConnectionTestResult,
  MySQLExportRequest,
  MySQLTable,
  ViewKey
} from '../../../shared/types'
import {
  validateMySQLBatchExportRequest,
  validateMySQLExportRequest
} from '../../../shared/validation'
import { MySQLImportTab } from './MySQLImportTab'

interface MySQLMigrationPanelProps {
  connections: ConnectionConfig[]
  onNavigate: (view: ViewKey) => void
}

type MySQLSubTab = 'export' | 'import'

/**
 * MySQL 迁移面板：导出 + 导入两个 tab。基于 PM Design §3 的 UI demo 落地：
 * - 导出 tab 沿用原 `MySQLExportTab` 行为（多选表 → 目录选择器，单表 → 文件选择器）。
 * - 导入 tab 与导出镜像对称，但表名改为文本框（目标表不能从源库拉），
 *   冲突策略三态（error / skip / update）。
 */
export function MySQLMigrationPanel({
  connections,
  onNavigate
}: MySQLMigrationPanelProps): ReactElement {
  const mysqlConnections = useMemo(
    () => connections.filter((connection) => connection.type === 'mysql'),
    [connections]
  )

  const [connectionId, setConnectionId] = useState('')
  const [databases, setDatabases] = useState<string[]>([])
  const [database, setDatabase] = useState('')
  const [tables, setTables] = useState<MySQLTable[]>([])
  const [tableSearch, setTableSearch] = useState('')
  const [selectedTableKeys, setSelectedTableKeys] = useState<string[]>([])
  const [tableRowCounts, setTableRowCounts] = useState<Record<string, number>>({})
  const [pendingRowCounts, setPendingRowCounts] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState<
    'idle' | 'testing' | 'loading-tables' | 'exporting'
  >('idle')
  const [testResult, setTestResult] = useState<MySQLConnectionTestResult | null>(null)
  const [filePath, setFilePath] = useState('')
  const [exportDirectory, setExportDirectory] = useState('')
  const [batchSize, setBatchSize] = useState('500')
  const [error, setError] = useState<string | null>(null)
  const [subTab, setSubTab] = useState<MySQLSubTab>('export')
  const rowCountRequestId = useRef(0)

  const selectedConnection =
    mysqlConnections.find((connection) => connection.id === connectionId) ?? null
  const selectedTables = useMemo(
    () => tables.filter((table) => selectedTableKeys.includes(tableKeyFor(table))),
    [tables, selectedTableKeys]
  )
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
    targetTables: MySQLTable[],
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
          const count = await window.api.mysql.countRows({
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

  function rowCountLabel(table: MySQLTable): string {
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

  // 选择连接后拉取数据库列表并重置下游状态（关键交互路径 1）。
  useEffect(() => {
    if (!connectionId) {
      setDatabases([])
      setDatabase('')
      setTables([])
      setSelectedTableKeys([])
      return
    }

    let disposed = false
    setLoading('loading-tables')
    setError(null)
    const selected = mysqlConnections.find(
      (connection) => connection.id === connectionId
    )
    window.api.mysql
      .databases(connectionId)
      .then((nextDatabases) => {
        if (disposed) {
          return
        }
        setDatabases(nextDatabases)
        const fallback =
          selected?.database && nextDatabases.includes(selected.database)
            ? selected.database
            : nextDatabases[0] ?? selected?.database ?? ''
        setDatabase((current) =>
          current && nextDatabases.includes(current) ? current : fallback
        )
      })
      .catch((cause) => {
        if (!disposed) {
          setDatabases(selected?.database ? [selected.database] : [])
          setDatabase((current) => current || selected?.database || '')
          setError(errorMessage(cause))
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading('idle')
        }
      })

    return () => {
      disposed = true
    }
  }, [connectionId, mysqlConnections])

  // 选择数据库后拉取表列表 + 行数预取。
  useEffect(() => {
    if (!connectionId || !database) {
      return
    }

    let disposed = false
    setLoading('loading-tables')
    setError(null)
    window.api.mysql
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
        void startRowCounts(nextTables, connectionId, database)
      })
      .catch((cause) => {
        if (!disposed) {
          setError(errorMessage(cause))
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading('idle')
        }
      })

    return () => {
      disposed = true
    }
  }, [connectionId, database])

  function resetExportTargets(): void {
    setFilePath('')
    setExportDirectory('')
    setError(null)
  }

  function selectConnection(nextConnectionId: string): void {
    setConnectionId(nextConnectionId)
    setDatabases([])
    setDatabase('')
    setTables([])
    setTableSearch('')
    setSelectedTableKeys([])
    setTableRowCounts({})
    setPendingRowCounts({})
    setTestResult(null)
    resetExportTargets()
  }

  function selectDatabase(nextDatabase: string): void {
    setDatabase(nextDatabase)
    setTables([])
    setTableSearch('')
    setSelectedTableKeys([])
    setTableRowCounts({})
    setPendingRowCounts({})
    resetExportTargets()
  }

  // 关键交互路径 2：测试连接（错误信息保留 errno 且中文可读）。
  async function handleTest(): Promise<void> {
    if (!selectedConnection) {
      setError('请先选择连接')
      return
    }
    setLoading('testing')
    setTestResult(null)
    setError(null)
    try {
      const test = await window.api.mysql.test(selectedConnection.id, database)
      setTestResult(test)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading('idle')
    }
  }

  // 关键交互路径 3：刷新表列表 + 行数预取。
  async function handleLoadTables(): Promise<void> {
    if (!selectedConnection) {
      setError('请先选择连接')
      return
    }
    if (!database) {
      setError('请先选择数据库')
      return
    }
    setLoading('loading-tables')
    setError(null)
    try {
      const nextTables = await window.api.mysql.tables(selectedConnection.id, database)
      setTables(nextTables)
      const firstKey = nextTables[0] ? tableKeyFor(nextTables[0]) : ''
      const availableKeys = new Set(nextTables.map(tableKeyFor))
      setSelectedTableKeys((current) => {
        const kept = current.filter((key) => availableKeys.has(key))
        return kept.length > 0 ? kept : firstKey ? [firstKey] : []
      })
      void startRowCounts(nextTables, selectedConnection.id, database)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading('idle')
    }
  }

  function toggleTable(key: string): void {
    setSelectedTableKeys((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key]
    )
    resetExportTargets()
  }

  function selectAllTables(): void {
    setSelectedTableKeys(tables.map(tableKeyFor))
    resetExportTargets()
  }

  function clearTableSelection(): void {
    setSelectedTableKeys([])
    resetExportTargets()
  }

  async function handleChooseFile(): Promise<void> {
    try {
      if (selectedTables.length > 1) {
        const directory = await window.api.dialog.chooseExportDirectory()
        if (directory) {
          setExportDirectory(directory)
        }
      } else {
        const suggestedName = selectedTables[0]
          ? `${selectedTables[0].schema}.${selectedTables[0].name}.jsonl`
          : 'mysql-export.jsonl'
        const path = await window.api.dialog.chooseExportFile(suggestedName)
        if (path) {
          setFilePath(path)
        }
      }
      setError(null)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  // 关键交互路径 4：开始导出 → 创建任务 → 跳到任务列表。
  async function handleStart(): Promise<void> {
    const parsedBatchSize = Number(batchSize)
    setLoading('exporting')
    setError(null)
    try {
      if (selectedTables.length === 0) {
        setError('请至少选择一张表')
        return
      }
      if (selectedTables.length === 1) {
        const selected = selectedTables[0]
        if (!selected) {
          setError('请选择一张表')
          return
        }
        const request: MySQLExportRequest = {
          connectionId,
          table: { schema: selected.schema, name: selected.name },
          outputFile: filePath,
          batchSize: parsedBatchSize,
          database
        }
        const validation = validateMySQLExportRequest(request)
        if (!validation.ok) {
          setError(validation.errors.join('；'))
          return
        }
        await window.api.tasks.create({
          type: 'mysql-export',
          payload: validation.value
        })
      } else {
        const request: MySQLBatchExportRequest = {
          connectionId,
          tables: selectedTables.map((table) => ({
            schema: table.schema,
            name: table.name
          })),
          outputDirectory: exportDirectory,
          batchSize: parsedBatchSize,
          database
        }
        const validation = validateMySQLBatchExportRequest(request)
        if (!validation.ok) {
          setError(validation.errors.join('；'))
          return
        }
        await window.api.tasks.create({
          type: 'mysql-export-batch',
          payload: validation.value
        })
      }
      onNavigate('tasks')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading('idle')
    }
  }

  if (mysqlConnections.length === 0) {
    return (
      <div className="migration-engine">
        <div className="empty-state">
          <Database size={30} />
          <span>还没有 MySQL 连接</span>
          <button
            type="button"
            className="button button-primary"
            onClick={() => onNavigate('connections')}
          >
            管理连接
          </button>
        </div>
      </div>
    )
  }

  const exporting = loading === 'exporting'
  const canStart =
    !exporting &&
    Boolean(selectedConnection) &&
    Boolean(database) &&
    selectedTables.length > 0 &&
    (selectedTables.length > 1 ? Boolean(exportDirectory) : Boolean(filePath))

  return (
    <div className="migration-engine">
      <div className="toolbar">
        <div className="segmented">
          <button
            type="button"
            className={`segment ${subTab === 'export' ? 'segment-active' : ''}`}
            aria-pressed={subTab === 'export'}
            onClick={() => setSubTab('export')}
          >
            <HardDriveDownload size={15} />
            导出
          </button>
          <button
            type="button"
            className={`segment ${subTab === 'import' ? 'segment-active' : ''}`}
            aria-pressed={subTab === 'import'}
            onClick={() => setSubTab('import')}
          >
            <FileInput size={15} />
            导入
          </button>
        </div>
        {subTab === 'export' ? (
          <>
            <span className="badge">表 → 文件</span>
            <span className="badge">
              <FileJson size={13} />
              流式 JSONL · 与 PG/ES 互兼容
            </span>
          </>
        ) : (
          <>
            <span className="badge">文件 → 表</span>
            <span className="badge">
              <FileJson size={13} />
              流式 JSONL · 兼容 PG/ES/MySQL 导出
            </span>
          </>
        )}
      </div>

      {subTab === 'export' ? (
        <MySQLExportView
          mysqlConnections={mysqlConnections}
          connectionId={connectionId}
          selectConnection={selectConnection}
          database={database}
          databases={databases}
          selectDatabase={selectDatabase}
          tables={tables}
          tableSearch={tableSearch}
          setTableSearch={setTableSearch}
          visibleTables={visibleTables}
          selectedTableKeys={selectedTableKeys}
          toggleTable={toggleTable}
          selectAllTables={selectAllTables}
          clearTableSelection={clearTableSelection}
          loading={loading}
          selectedConnection={selectedConnection}
          testResult={testResult}
          handleTest={handleTest}
          handleLoadTables={handleLoadTables}
          rowCountLabel={rowCountLabel}
          filePath={filePath}
          exportDirectory={exportDirectory}
          handleChooseFile={handleChooseFile}
          batchSize={batchSize}
          setBatchSize={setBatchSize}
          exporting={exporting}
          canStart={canStart}
          handleStart={handleStart}
          selectedTables={selectedTables}
          error={error}
        />
      ) : (
        <MySQLImportTab
          connections={connections}
          onNavigate={(view) => onNavigate(view)}
        />
      )}
    </div>
  )
}

/** 导出视图子组件，把现有 UI 拆分出来保持可读性。 */
interface MySQLExportViewProps {
  mysqlConnections: ConnectionConfig[]
  connectionId: string
  selectConnection: (id: string) => void
  database: string
  databases: string[]
  selectDatabase: (database: string) => void
  tables: MySQLTable[]
  tableSearch: string
  setTableSearch: (v: string) => void
  visibleTables: MySQLTable[]
  selectedTableKeys: string[]
  toggleTable: (key: string) => void
  selectAllTables: () => void
  clearTableSelection: () => void
  loading: 'idle' | 'testing' | 'loading-tables' | 'exporting'
  selectedConnection: ConnectionConfig | null
  testResult: MySQLConnectionTestResult | null
  handleTest: () => Promise<void>
  handleLoadTables: () => Promise<void>
  rowCountLabel: (table: MySQLTable) => string
  filePath: string
  exportDirectory: string
  handleChooseFile: () => Promise<void>
  batchSize: string
  setBatchSize: (v: string) => void
  exporting: boolean
  canStart: boolean
  handleStart: () => Promise<void>
  selectedTables: MySQLTable[]
  error: string | null
}

function MySQLExportView(props: MySQLExportViewProps): ReactElement {
  const {
    mysqlConnections,
    connectionId,
    selectConnection,
    database,
    databases,
    selectDatabase,
    tables,
    tableSearch,
    setTableSearch,
    visibleTables,
    selectedTableKeys,
    toggleTable,
    selectAllTables,
    clearTableSelection,
    loading,
    selectedConnection,
    testResult,
    handleTest,
    handleLoadTables,
    rowCountLabel,
    filePath,
    exportDirectory,
    handleChooseFile,
    batchSize,
    setBatchSize,
    exporting,
    canStart,
    handleStart,
    selectedTables,
    error
  } = props

  return (
    <div className="migration-grid">
      <section className="section migration-section">
        <div className="section-heading">
          <h2>连接与表</h2>
          <span className="badge">MySQL</span>
        </div>
        <div className="migration-body">
          <div className="field-grid">
            <div className="field">
              <label htmlFor="mysql-connection">连接</label>
              <select
                id="mysql-connection"
                value={connectionId}
                onChange={(event) => selectConnection(event.target.value)}
              >
                <option value="">选择连接</option>
                {mysqlConnections.map((connection) => (
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
                  disabled={!selectedConnection || loading === 'testing'}
                  onClick={() => void handleTest()}
                >
                  {loading === 'testing' ? (
                    <Loader2 className="spin" size={15} />
                  ) : (
                    <PlugZap size={15} />
                  )}
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
            <label htmlFor="mysql-database">数据库</label>
            <select
              id="mysql-database"
              value={database}
              disabled={!selectedConnection || (databases.length === 0 && !database)}
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
            <label htmlFor="mysql-table-search">
              表 <span className="hint">多选导出每表一个 JSONL 文件</span>
            </label>
            <div className="table-picker-wrap">
              <div className="search-box table-search">
                <Search size={14} />
                <input
                  id="mysql-table-search"
                  value={tableSearch}
                  onChange={(event) => setTableSearch(event.target.value)}
                  placeholder="搜索表名"
                  aria-label="搜索表名"
                />
              </div>
              <div className="table-picker" role="group" aria-label="MySQL 表列表">
                {!connectionId ? (
                  <div className="table-picker-empty">请先选择连接</div>
                ) : !database ? (
                  <div className="table-picker-empty">请选择数据库</div>
                ) : loading === 'loading-tables' ? (
                  <div className="table-picker-empty table-picker-loading">
                    <Loader2 className="spin" size={14} />
                    正在加载表…
                  </div>
                ) : tables.length === 0 ? (
                  <div className="table-picker-empty">当前数据库没有可导出的表</div>
                ) : visibleTables.length === 0 ? (
                  <div className="table-picker-empty">没有匹配的表</div>
                ) : (
                  visibleTables.map((table) => {
                    const key = tableKeyFor(table)
                    return (
                      <label key={key} className="table-picker-row">
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
                  disabled={!selectedConnection || !database || loading === 'loading-tables'}
                  onClick={() => void handleLoadTables()}
                >
                  {loading === 'loading-tables' ? (
                    <Loader2 className="spin" size={14} />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  刷新
                </button>
              </div>
            </div>
          </div>

          {selectedTables.length > 0 ? (
            <div className="table-summary">
              <span className="table-summary-icon">
                {selectedTables.length > 1 ? <ListChecks size={16} /> : <Table2 size={16} />}
              </span>
              <span className="badge">{selectedTables.length} 张表</span>
              {selectedTables.length === 1 && selectedTables[0] ? (
                <>
                  <span className="badge">{selectedTables[0].columns.length} 列</span>
                  <span className="badge">{rowCountLabel(selectedTables[0])}</span>
                  {selectedTables[0].columns.some((column) => column.isPrimaryKey) ? (
                    <span className="badge">有主键</span>
                  ) : null}
                </>
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
            <label>{selectedTables.length > 1 ? '导出目录' : '导出文件'}</label>
            <div className="file-picker">
              <input
                className="file-path"
                value={selectedTables.length > 1 ? exportDirectory : filePath}
                readOnly
                placeholder={selectedTables.length > 1 ? '选择导出目录' : '选择输出文件'}
              />
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void handleChooseFile()}
              >
                {selectedTables.length > 1 ? (
                  <FolderOutput size={15} />
                ) : (
                  <FolderOpen size={15} />
                )}
                {selectedTables.length > 1 ? '选择目录' : '选择文件'}
              </button>
            </div>
          </div>

          <div className="field">
            <label htmlFor="mysql-batch-size">批量大小</label>
            <input
              id="mysql-batch-size"
              type="number"
              min={1}
              max={10000}
              value={batchSize}
              onChange={(event) => setBatchSize(event.target.value)}
            />
          </div>

          <div className="migration-action-row">
            <button
              type="button"
              className="button button-primary"
              disabled={!canStart}
              onClick={() => void handleStart()}
            >
              {exporting ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <HardDriveDownload size={16} />
              )}
              开始导出
            </button>
            <span className="badge">
              <FileJson size={13} />
              {batchSize ? `每批 ${batchSize} 行` : '每批 500 行'}
            </span>
          </div>
        </div>
      </section>

      {error ? (
        <div className="inline-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  )
}

function tableKeyFor(table: MySQLTable): string {
  return `${table.schema}.${table.name}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '迁移操作失败'
}
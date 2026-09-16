import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Check,
  CheckSquare,
  Database,
  FileJson,
  FolderOpen,
  FolderOutput,
  Loader2,
  PlugZap,
  RefreshCw,
  Search,
  Square,
  X
} from 'lucide-react'

import type {
  ConnectionConfig,
  SQLiteBatchExportRequest,
  SQLiteConnectionTestResult,
  SQLiteExportRequest,
  SQLiteTable,
  ViewKey
} from '../../../shared/types'
import {
  validateSQLiteBatchExportRequest,
  validateSQLiteExportRequest
} from '../../../shared/validation'

interface SQLiteMigrationPanelProps {
  connections: ConnectionConfig[]
  onNavigate: (view: ViewKey) => void
}

type Status =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string }

export function SQLiteMigrationPanel({
  connections,
  onNavigate
}: SQLiteMigrationPanelProps): ReactElement {
  const sqliteConnections = useMemo(
    () => connections.filter((connection) => connection.type === 'sqlite'),
    [connections]
  )
  const [connectionId, setConnectionId] = useState('')
  const [tables, setTables] = useState<SQLiteTable[]>([])
  const [selectedTableKeys, setSelectedTableKeys] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [rowCounts, setRowCounts] = useState<Record<string, number>>({})
  const [loadingTables, setLoadingTables] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<SQLiteConnectionTestResult | null>(null)
  const [outputPath, setOutputPath] = useState('')
  const [outputDirectory, setOutputDirectory] = useState('')
  const [batchSize, setBatchSize] = useState('500')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const selectedConnection =
    sqliteConnections.find((connection) => connection.id === connectionId) ?? null
  const selectedTables = tables.filter((table) =>
    selectedTableKeys.includes(tableKeyFor(table))
  )
  const visibleTables = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    const filtered = keyword
      ? tables.filter((table) => table.name.toLowerCase().includes(keyword))
      : tables
    return filtered.slice(0, 500)
  }, [search, tables])

  useEffect(() => {
    if (!connectionId) {
      setTables([])
      setSelectedTableKeys([])
      setRowCounts({})
      return
    }

    let disposed = false
    setLoadingTables(true)
    setStatus({ kind: 'idle' })
    window.api.sqlite
      .tables(connectionId)
      .then((nextTables) => {
        if (disposed) {
          return
        }
        setTables(nextTables)
        const first = nextTables[0]
        setSelectedTableKeys(first ? [tableKeyFor(first)] : [])
        void loadRowCounts(connectionId, nextTables, setRowCounts)
      })
      .catch((cause) => {
        if (!disposed) {
          setStatus({ kind: 'error', message: errorMessage(cause) })
          setTables([])
          setSelectedTableKeys([])
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
  }, [connectionId])

  async function reloadTables(): Promise<void> {
    if (!connectionId) {
      return
    }
    setLoadingTables(true)
    try {
      const nextTables = await window.api.sqlite.tables(connectionId)
      setTables(nextTables)
      const available = new Set(nextTables.map(tableKeyFor))
      setSelectedTableKeys((current) => {
        const kept = current.filter((key) => available.has(key))
        const first = nextTables[0]
        return kept.length > 0 ? kept : first ? [tableKeyFor(first)] : []
      })
      await loadRowCounts(connectionId, nextTables, setRowCounts)
    } catch (cause) {
      setStatus({ kind: 'error', message: errorMessage(cause) })
    } finally {
      setLoadingTables(false)
    }
  }

  async function testConnection(): Promise<void> {
    if (!connectionId) {
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await window.api.sqlite.test(connectionId))
    } catch (cause) {
      setTestResult({ ok: false, message: errorMessage(cause) })
    } finally {
      setTesting(false)
    }
  }

  async function chooseOutput(): Promise<void> {
    try {
      if (selectedTables.length > 1) {
        const directory = await window.api.dialog.chooseExportDirectory()
        if (directory) {
          setOutputDirectory(directory)
        }
      } else {
        const suggested = selectedTables[0]
          ? `main.${selectedTables[0].name}.jsonl`
          : 'sqlite-export.jsonl'
        const file = await window.api.dialog.chooseExportFile(suggested)
        if (file) {
          setOutputPath(file)
        }
      }
      setStatus({ kind: 'idle' })
    } catch (cause) {
      setStatus({ kind: 'error', message: errorMessage(cause) })
    }
  }

  async function startExport(): Promise<void> {
    const parsedBatchSize = Number(batchSize)
    if (selectedTables.length === 1) {
      const table = selectedTables[0]
      if (!table) {
        return
      }
      const request: SQLiteExportRequest = {
        connectionId,
        table: { schema: table.schema, name: table.name },
        outputFile: outputPath,
        batchSize: parsedBatchSize
      }
      const validation = validateSQLiteExportRequest(request)
      if (!validation.ok) {
        setStatus({ kind: 'error', message: validation.errors.join('；') })
        return
      }
      setStatus({ kind: 'submitting' })
      try {
        await window.api.tasks.create({
          type: 'sqlite-export',
          payload: validation.value
        })
        onNavigate('tasks')
      } catch (cause) {
        setStatus({ kind: 'error', message: errorMessage(cause) })
      }
      return
    }

    const request: SQLiteBatchExportRequest = {
      connectionId,
      tables: selectedTables.map((table) => ({
        schema: table.schema,
        name: table.name
      })),
      outputDirectory,
      batchSize: parsedBatchSize
    }
    const validation = validateSQLiteBatchExportRequest(request)
    if (!validation.ok) {
      setStatus({ kind: 'error', message: validation.errors.join('；') })
      return
    }
    setStatus({ kind: 'submitting' })
    try {
      await window.api.tasks.create({
        type: 'sqlite-export-batch',
        payload: validation.value
      })
      onNavigate('tasks')
    } catch (cause) {
      setStatus({ kind: 'error', message: errorMessage(cause) })
    }
  }

  if (sqliteConnections.length === 0) {
    return (
      <div className="empty-state">
        <Database size={30} />
        <span>还没有 SQLite 连接</span>
        <button
          type="button"
          className="button button-primary"
          onClick={() => onNavigate('connections')}
        >
          管理连接
        </button>
      </div>
    )
  }

  const submitting = status.kind === 'submitting'
  const canStart =
    !submitting &&
    Boolean(connectionId) &&
    selectedTables.length > 0 &&
    (selectedTables.length === 1 ? Boolean(outputPath) : Boolean(outputDirectory))

  return (
    <>
      <div className="toolbar">
        <div className="segmented">
          <span className="segment segment-active">
            <FileJson size={14} />
            导出
          </span>
        </div>
        <span className="badge">本地文件 → JSONL</span>
      </div>

      <div className="migration-grid">
        <section className="section migration-section">
          <div className="section-heading">
            <h2>连接与表</h2>
            <span className="badge">SQLite</span>
          </div>
          <div className="migration-body">
            <div className="field">
              <label htmlFor="sqlite-connection">连接</label>
              <div className="field-row">
                <select
                  id="sqlite-connection"
                  value={connectionId}
                  onChange={(event) => {
                    setConnectionId(event.target.value)
                    setTestResult(null)
                    setOutputPath('')
                    setOutputDirectory('')
                  }}
                >
                  <option value="">选择连接</option>
                  {sqliteConnections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={!connectionId || testing || submitting}
                  onClick={() => void testConnection()}
                >
                  {testing ? <Loader2 className="spin" size={14} /> : <PlugZap size={14} />}
                  测试连接
                </button>
              </div>
              {selectedConnection ? (
                <span className="field-hint">
                  {selectedConnection.filePath ?? selectedConnection.host}
                </span>
              ) : null}
              {testResult ? (
                <span className={`badge ${testResult.ok ? 'badge-ok' : 'badge-error'}`}>
                  {testResult.ok ? (
                    <>
                      <Check size={12} /> SQLite {testResult.serverVersion ?? ''}
                    </>
                  ) : (
                    <>
                      <X size={12} /> {testResult.message ?? '连接失败'}
                    </>
                  )}
                </span>
              ) : null}
            </div>

            <div className="field">
              <label>表</label>
              <div className="search-box table-search">
                <Search size={14} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索表名"
                />
              </div>
              <div className="table-picker">
                {!connectionId ? (
                  <div className="table-picker-empty">请先选择连接</div>
                ) : loadingTables ? (
                  <div className="table-picker-empty table-picker-loading">
                    <Loader2 className="spin" size={14} />
                    正在加载表…
                  </div>
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
                          onChange={() => {
                            setSelectedTableKeys((current) =>
                              current.includes(key)
                                ? current.filter((item) => item !== key)
                                : [...current, key]
                            )
                            setOutputPath('')
                            setOutputDirectory('')
                          }}
                        />
                        <span className="table-picker-name">{table.name}</span>
                        <span className="badge">{table.columns.length} 列</span>
                        <span className="badge">
                          {rowCounts[key] === undefined
                            ? '...'
                            : `${rowCounts[key].toLocaleString()} 行`}
                        </span>
                      </label>
                    )
                  })
                )}
              </div>
              <div className="table-picker-actions">
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={visibleTables.length === 0}
                  onClick={() => setSelectedTableKeys(tables.map(tableKeyFor))}
                >
                  <CheckSquare size={14} />
                  全选
                </button>
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={selectedTableKeys.length === 0}
                  onClick={() => {
                    setSelectedTableKeys([])
                    setOutputPath('')
                    setOutputDirectory('')
                  }}
                >
                  <Square size={14} />
                  清空
                </button>
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={!connectionId || loadingTables}
                  onClick={() => void reloadTables()}
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
          </div>
        </section>

        <section className="section migration-section">
          <div className="section-heading">
            <h2>文件与选项</h2>
            <span className="badge">{selectedTables.length} 张表</span>
          </div>
          <div className="migration-body">
            <div className="field">
              <label>{selectedTables.length > 1 ? '导出目录' : '导出文件'}</label>
              <div className="file-picker">
                <input
                  className="file-path"
                  value={selectedTables.length > 1 ? outputDirectory : outputPath}
                  readOnly
                  placeholder={selectedTables.length > 1 ? '选择导出目录' : '选择输出文件'}
                />
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={selectedTables.length === 0 || submitting}
                  onClick={() => void chooseOutput()}
                >
                  {selectedTables.length > 1 ? (
                    <FolderOutput size={15} />
                  ) : (
                    <FolderOpen size={15} />
                  )}
                  选择
                </button>
              </div>
            </div>

            <div className="field">
              <label htmlFor="sqlite-batch-size">批量大小</label>
              <input
                id="sqlite-batch-size"
                type="number"
                min={1}
                max={10000}
                value={batchSize}
                onChange={(event) => setBatchSize(event.target.value)}
              />
            </div>

            {status.kind === 'error' ? (
              <div className="inline-error" role="alert">
                {status.message}
              </div>
            ) : null}

            <div className="migration-action-row">
              <button
                type="button"
                className="button button-primary"
                disabled={!canStart}
                onClick={() => void startExport()}
              >
                {submitting ? (
                  <Loader2 className="spin" size={16} />
                ) : (
                  <FileJson size={16} />
                )}
                {submitting ? '提交中…' : '开始导出'}
              </button>
              <span className="badge">
                {batchSize ? `每批 ${batchSize} 行` : '每批 500 行'}
              </span>
            </div>
          </div>
        </section>
      </div>
    </>
  )
}

async function loadRowCounts(
  connectionId: string,
  tables: SQLiteTable[],
  setCounts: (updater: (current: Record<string, number>) => Record<string, number>) => void
): Promise<void> {
  const queue = [...tables]
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length > 0) {
      const table = queue.shift()
      if (!table) {
        continue
      }
      try {
        const count = await window.api.sqlite.countRows({
          connectionId,
          table: { schema: table.schema, name: table.name }
        })
        setCounts((current) => ({ ...current, [tableKeyFor(table)]: count }))
      } catch {
        // Keep the loading placeholder when an individual count fails.
      }
    }
  })
  await Promise.all(workers)
}

function tableKeyFor(table: SQLiteTable): string {
  return `${table.schema}.${table.name}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'SQLite 操作失败'
}

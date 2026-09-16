import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Check,
  Database,
  FileJson,
  FolderOpen,
  Loader2,
  PlugZap,
  RefreshCw,
  Search,
  X
} from 'lucide-react'

import type {
  ConnectionConfig,
  FieldTransform,
  HiveConnectionTestResult,
  HiveExportRequest,
  HiveImportRequest,
  HiveTable,
  ViewKey
} from '../../../shared/types'
import {
  validateHiveExportRequest,
  validateHiveImportRequest
} from '../../../shared/validation'
import { ColumnSelection } from '../components/ColumnSelection'
import { FieldTransformsEditor } from '../components/FieldTransformsEditor'

interface HiveMigrationPanelProps {
  connections: ConnectionConfig[]
  onNavigate: (view: ViewKey) => void
}

type Status =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string }

type PanelMode = 'export' | 'import'

export function HiveMigrationPanel({
  connections,
  onNavigate
}: HiveMigrationPanelProps): ReactElement {
  const hiveConnections = useMemo(
    () => connections.filter((connection) => connection.type === 'hive'),
    [connections]
  )
  const [connectionId, setConnectionId] = useState('')
  const [mode, setMode] = useState<PanelMode>('export')
  const [databases, setDatabases] = useState<string[]>([])
  const [database, setDatabase] = useState('')
  const [tables, setTables] = useState<HiveTable[]>([])
  const [tableName, setTableName] = useState('')
  const [search, setSearch] = useState('')
  const [rowCount, setRowCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<HiveConnectionTestResult | null>(null)
  const [filePath, setFilePath] = useState('')
  const [batchSize, setBatchSize] = useState('500')
  const [selectedColumns, setSelectedColumns] = useState<string[]>([])
  const [fieldTransforms, setFieldTransforms] = useState<FieldTransform[]>([])
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const selectedConnection =
    hiveConnections.find((connection) => connection.id === connectionId) ?? null
  const visibleTables = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    const filtered = keyword
      ? tables.filter((table) => table.name.toLowerCase().includes(keyword))
      : tables
    return filtered.slice(0, 500)
  }, [search, tables])

  useEffect(() => {
    if (!connectionId) {
      setDatabases([])
      setDatabase('')
      setTables([])
      setTableName('')
      return
    }
    let disposed = false
    setLoading(true)
    window.api.hive
      .databases(connectionId)
      .then((nextDatabases) => {
        if (disposed) {
          return
        }
        setDatabases(nextDatabases)
        const fallback =
          selectedConnection?.database && nextDatabases.includes(selectedConnection.database)
            ? selectedConnection.database
            : nextDatabases[0] ?? selectedConnection?.database ?? ''
        setDatabase(fallback)
      })
      .catch((cause) => {
        if (!disposed) {
          setStatus({ kind: 'error', message: errorMessage(cause) })
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false)
        }
      })
    return () => {
      disposed = true
    }
  }, [connectionId, selectedConnection])

  async function loadTables(targetDatabase = database): Promise<void> {
    if (!connectionId || !targetDatabase) {
      return
    }
    setLoading(true)
    setStatus({ kind: 'idle' })
    setRowCount(null)
    try {
      const nextTables = await window.api.hive.tables(connectionId, targetDatabase)
      setTables(nextTables)
      setTableName((current) =>
        nextTables.some((table) => table.name === current)
          ? current
          : nextTables[0]?.name ?? ''
      )
    } catch (cause) {
      setStatus({ kind: 'error', message: errorMessage(cause) })
      setTables([])
      setTableName('')
    } finally {
      setLoading(false)
    }
  }

  async function testConnection(): Promise<void> {
    if (!connectionId) {
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await window.api.hive.test(connectionId))
    } catch (cause) {
      setTestResult({ ok: false, message: errorMessage(cause) })
    } finally {
      setTesting(false)
    }
  }

  async function countSelectedTable(): Promise<void> {
    if (!connectionId || !database || !tableName) {
      return
    }
    try {
      setRowCount(
        await window.api.hive.countRows({
          connectionId,
          table: { database, name: tableName }
        })
      )
    } catch (cause) {
      setStatus({ kind: 'error', message: errorMessage(cause) })
    }
  }

  async function chooseFile(): Promise<void> {
    try {
      const path =
        mode === 'export'
          ? await window.api.dialog.chooseExportFile(
              database && tableName
                ? `${database}.${tableName}.jsonl`
                : 'hive-export.jsonl'
            )
          : await window.api.dialog.chooseImportFile()
      if (path) {
        setFilePath(path)
        setSelectedColumns([])
        setFieldTransforms([])
      }
    } catch (cause) {
      setStatus({ kind: 'error', message: errorMessage(cause) })
    }
  }

  async function startMigration(): Promise<void> {
    const validation =
      mode === 'export'
        ? validateHiveExportRequest({
            connectionId,
            table: { database, name: tableName },
            outputFile: filePath,
            batchSize: Number(batchSize)
          } satisfies HiveExportRequest)
        : validateHiveImportRequest({
            connectionId,
            table: { database, name: tableName },
            inputFile: filePath,
            batchSize: Number(batchSize),
            ...(selectedColumns.length > 0 ? { selectedColumns } : {}),
            ...(fieldTransforms.length > 0 ? { fieldTransforms } : {})
          } satisfies HiveImportRequest)
    if (!validation.ok) {
      setStatus({ kind: 'error', message: validation.errors.join('；') })
      return
    }
    setStatus({ kind: 'submitting' })
    try {
      await window.api.tasks.create({
        type: mode === 'export' ? 'hive-export' : 'hive-import',
        payload: validation.value
      })
      onNavigate('tasks')
    } catch (cause) {
      setStatus({ kind: 'error', message: errorMessage(cause) })
    }
  }

  if (hiveConnections.length === 0) {
    return (
      <div className="empty-state">
        <Database size={30} />
        <span>还没有 Hive 连接</span>
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
    Boolean(database) &&
    Boolean(tableName) &&
    Boolean(filePath)

  return (
    <>
      <div className="toolbar">
        <div className="segmented">
          <button
            type="button"
            className={mode === 'export' ? 'segment segment-active' : 'segment'}
            onClick={() => {
              setMode('export')
              setFilePath('')
              setSelectedColumns([])
              setFieldTransforms([])
              setStatus({ kind: 'idle' })
            }}
          >
            <FileJson size={14} />
            导出
          </button>
          <button
            type="button"
            className={mode === 'import' ? 'segment segment-active' : 'segment'}
            onClick={() => {
              setMode('import')
              setFilePath('')
              setSelectedColumns([])
              setFieldTransforms([])
              setStatus({ kind: 'idle' })
            }}
          >
            <FileJson size={14} />
            导入
          </button>
        </div>
        <span className="badge">
          {mode === 'export' ? '表 → JSONL' : 'JSONL → 表（追加）'}
        </span>
      </div>

      <div className="migration-grid">
        <section className="section migration-section">
          <div className="section-heading">
            <h2>连接与表</h2>
            <span className="badge">Hive</span>
          </div>
          <div className="migration-body">
            <div className="field">
              <label htmlFor="hive-connection">连接</label>
              <div className="field-row">
                <select
                  id="hive-connection"
                  value={connectionId}
                  onChange={(event) => {
                    setConnectionId(event.target.value)
                    setTestResult(null)
                    setFilePath('')
                    setSelectedColumns([])
                    setFieldTransforms([])
                    setTables([])
                    setTableName('')
                    setRowCount(null)
                    setSelectedColumns([])
                    setFieldTransforms([])
                  }}
                >
                  <option value="">选择连接</option>
                  {hiveConnections.map((connection) => (
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
              {testResult ? (
                <span className={`badge ${testResult.ok ? 'badge-ok' : 'badge-error'}`}>
                  {testResult.ok ? (
                    <>
                      <Check size={12} /> {testResult.transportMode} {testResult.serverVersion ?? ''}
                    </>
                  ) : (
                    <>
                      <X size={12} /> {testResult.message ?? '连接失败'}
                    </>
                  )}
                </span>
              ) : null}
            </div>

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

            <div className="field">
              <label htmlFor="hive-database">数据库</label>
              <div className="field-row">
                <select
                  id="hive-database"
                  value={database}
                  onChange={(event) => {
                    const next = event.target.value
                    setDatabase(next)
                    setTables([])
                    setTableName('')
                    setRowCount(null)
                    void loadTables(next)
                  }}
                  disabled={loading || databases.length === 0}
                >
                  <option value="">选择数据库</option>
                  {databases.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={!connectionId || !database || loading}
                  onClick={() => void loadTables()}
                >
                  {loading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                  刷新表
                </button>
              </div>
            </div>

            <div className="field">
              <label htmlFor="hive-table">表</label>
              <div className="search-box table-search">
                <Search size={14} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索表名"
                />
              </div>
              <select
                id="hive-table"
                value={tableName}
                onChange={(event) => {
                  setTableName(event.target.value)
                  setRowCount(null)
                  setSelectedColumns([])
                  setFieldTransforms([])
                }}
                disabled={visibleTables.length === 0}
              >
                <option value="">
                  {loading ? '正在加载表…' : '选择目标表'}
                </option>
                {visibleTables.map((table) => (
                  <option key={`${table.database}.${table.name}`} value={table.name}>
                    {table.name}
                  </option>
                ))}
              </select>
              <div className="field-row">
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={!tableName}
                  onClick={() => void countSelectedTable()}
                >
                  刷新行数
                </button>
                <span className="badge">
                  {rowCount === null ? '行数未加载' : `${rowCount.toLocaleString()} 行`}
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="section migration-section">
          <div className="section-heading">
            <h2>文件与选项</h2>
            <span className="badge">分页导出</span>
          </div>
          <div className="migration-body">
            <div className="field">
              <label>{mode === 'export' ? '导出文件' : '导入文件'}</label>
              <div className="file-picker">
                <input
                  className="file-path"
                  value={filePath}
                  readOnly
                  placeholder={mode === 'export' ? '选择输出文件' : '选择 JSONL 文件'}
                />
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={!tableName || submitting}
                  onClick={() => void chooseFile()}
                >
                  <FolderOpen size={15} />
                  选择
                </button>
              </div>
            </div>

            <div className="field">
              <label htmlFor="hive-batch-size">分页大小</label>
              <input
                id="hive-batch-size"
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
                onClick={() => void startMigration()}
              >
                {submitting ? (
                  <Loader2 className="spin" size={16} />
                ) : (
                  <FileJson size={16} />
                )}
                {submitting
                  ? '提交中…'
                  : mode === 'export'
                    ? '开始导出'
                    : '开始导入'}
              </button>
              <span className="badge">
                {mode === 'export'
                  ? `每页 ${batchSize || 500} 行`
                  : `每批 ${batchSize || 500} 行`}
              </span>
            </div>

            {mode === 'import' ? (
              <p className="field-hint">
                Hive 不支持 upsert；重复导入会追加重复行。
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Hive 操作失败'
}

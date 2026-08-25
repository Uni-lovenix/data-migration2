import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import {
  ArrowRightLeft,
  CheckCircle2,
  Database,
  FileJson,
  FolderOpen,
  HardDriveDownload,
  HardDriveUpload,
  Loader2,
  PlugZap,
  RefreshCw,
  Table2,
  XCircle
} from 'lucide-react'

import type {
  ConnectionConfig,
  PostgresConflictAction,
  PostgresConnectionTestResult,
  PostgresExportRequest,
  PostgresImportRequest,
  PostgresMigrationResult,
  PostgresTable,
  ViewKey
} from '../../../shared/types'
import {
  validatePostgresExportRequest,
  validatePostgresImportRequest
} from '../../../shared/validation'

interface MigrationPageProps {
  connections: ConnectionConfig[]
  onNavigate: (view: ViewKey) => void
}

type MigrationMode = 'export' | 'import'

export function MigrationPage({
  connections,
  onNavigate
}: MigrationPageProps): ReactElement {
  const postgresConnections = useMemo(
    () => connections.filter((connection) => connection.type === 'postgresql'),
    [connections]
  )
  const [mode, setMode] = useState<MigrationMode>('export')
  const [connectionId, setConnectionId] = useState('')
  const [tables, setTables] = useState<PostgresTable[]>([])
  const [tableKey, setTableKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<PostgresConnectionTestResult | null>(null)
  const [loadingTables, setLoadingTables] = useState(false)
  const [filePath, setFilePath] = useState('')
  const [batchSize, setBatchSize] = useState('500')
  const [onConflict, setOnConflict] = useState<PostgresConflictAction>('skip')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PostgresMigrationResult | null>(null)

  const selectedConnection =
    postgresConnections.find((connection) => connection.id === connectionId) ?? null
  const selectedTable =
    tables.find((table) => tableKeyFor(table) === tableKey) ?? null

  function changeMode(nextMode: MigrationMode): void {
    setMode(nextMode)
    setFilePath('')
    setResult(null)
    setError(null)
  }

  function selectConnection(nextConnectionId: string): void {
    setConnectionId(nextConnectionId)
    setTables([])
    setTableKey('')
    setTestResult(null)
    setResult(null)
    setError(null)
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
      const test = await window.api.postgres.test(selectedConnection.id)
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
      const nextTables = await window.api.postgres.tables(selectedConnection.id)
      setTables(nextTables)
      setTableKey(nextTables.length > 0 ? tableKeyFor(nextTables[0] as PostgresTable) : '')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoadingTables(false)
    }
  }

  async function handleChooseFile(): Promise<void> {
    try {
      if (mode === 'export') {
        const suggestedName = selectedTable
          ? `${selectedTable.schema}.${selectedTable.name}.jsonl`
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
    const table = selectedTable
      ? { schema: selectedTable.schema, name: selectedTable.name }
      : null
    const request =
      mode === 'export'
        ? {
            connectionId,
            table,
            outputFile: filePath,
            batchSize: parsedBatchSize
          }
        : {
            connectionId,
            table,
            inputFile: filePath,
            batchSize: parsedBatchSize,
            onConflict
          }
    const validation =
      mode === 'export'
        ? validatePostgresExportRequest(request as PostgresExportRequest)
        : validatePostgresImportRequest(request as PostgresImportRequest)
    if (!validation.ok) {
      setError(validation.errors.join('；'))
      return
    }

    setRunning(true)
    setError(null)
    setResult(null)
    try {
      let nextResult: PostgresMigrationResult | null = null
      if (mode === 'export' && validation.ok) {
        nextResult = await window.api.postgres.export(
          validation.value as PostgresExportRequest
        )
      } else if (mode === 'import' && validation.ok) {
        nextResult = await window.api.postgres.import(
          validation.value as PostgresImportRequest
        )
      }
      if (nextResult) {
        setResult(nextResult)
      }
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
          <h1>PostgreSQL 迁移</h1>
          <p>表数据导出与导入</p>
        </div>
        <span className="badge">JSONL</span>
      </div>

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
                  <label htmlFor="migration-table">表</label>
                  <div className="field-row">
                    <select
                      id="migration-table"
                      value={tableKey}
                      disabled={tables.length === 0}
                      onChange={(event) => setTableKey(event.target.value)}
                    >
                      {tables.length === 0 ? (
                        <option value="">先加载表</option>
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
                      disabled={!selectedConnection || loadingTables}
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
                </div>

                {selectedTable ? (
                  <div className="table-summary">
                    <span className="table-summary-icon">
                      <Table2 size={16} />
                    </span>
                    <span className="badge">{selectedTable.columns.length} 列</span>
                    <span className="badge">
                      {selectedTable.estimatedRows === null
                        ? '行数未知'
                        : `${selectedTable.estimatedRows.toLocaleString()} 行`}
                    </span>
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
                      onClick={() => void handleChooseFile()}
                    >
                      <FolderOpen size={15} />
                      选择文件
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

                <div className="migration-action-row">
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={running || !selectedConnection || !selectedTable || !filePath}
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
    </div>
  )
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

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
  X
} from 'lucide-react'

import type {
  AccessConnectionTestResult,
  AccessExportRequest,
  ConnectionConfig,
  ViewKey
} from '../../../shared/types'
import { validateAccessExportRequest } from '../../../shared/validation'

interface AccessMigrationPanelProps {
  connections: ConnectionConfig[]
  onNavigate: (view: ViewKey) => void
}

type Status =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string }

export function AccessMigrationPanel({
  connections,
  onNavigate
}: AccessMigrationPanelProps): ReactElement {
  const accessConnections = useMemo(
    () => connections.filter((connection) => connection.type === 'access'),
    [connections]
  )
  const [connectionId, setConnectionId] = useState('')
  const [tables, setTables] = useState<string[]>([])
  const [tableName, setTableName] = useState('')
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<AccessConnectionTestResult | null>(null)
  const [outputFile, setOutputFile] = useState('')
  const [batchSize, setBatchSize] = useState('500')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const selectedConnection =
    accessConnections.find((connection) => connection.id === connectionId) ?? null

  useEffect(() => {
    if (!connectionId) {
      setTables([])
      setTableName('')
      return
    }
    void loadTables()
  }, [connectionId])

  async function loadTables(): Promise<void> {
    if (!connectionId) {
      return
    }
    setLoading(true)
    setStatus({ kind: 'idle' })
    try {
      const nextTables = await window.api.access.tables(connectionId)
      setTables(nextTables)
      setTableName((current) =>
        nextTables.includes(current) ? current : nextTables[0] ?? ''
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
      setTestResult(await window.api.access.test(connectionId))
    } catch (cause) {
      setTestResult({ ok: false, message: errorMessage(cause) })
    } finally {
      setTesting(false)
    }
  }

  async function chooseOutput(): Promise<void> {
    try {
      const path = await window.api.dialog.chooseExportFile(
        tableName ? `access.${tableName}.jsonl` : 'access-export.jsonl'
      )
      if (path) {
        setOutputFile(path)
      }
    } catch (cause) {
      setStatus({ kind: 'error', message: errorMessage(cause) })
    }
  }

  async function startExport(): Promise<void> {
    const request: AccessExportRequest = {
      connectionId,
      table: tableName,
      outputFile,
      batchSize: Number(batchSize)
    }
    const validation = validateAccessExportRequest(request)
    if (!validation.ok) {
      setStatus({ kind: 'error', message: validation.errors.join('；') })
      return
    }
    setStatus({ kind: 'submitting' })
    try {
      await window.api.tasks.create({
        type: 'access-export',
        payload: validation.value
      })
      onNavigate('tasks')
    } catch (cause) {
      setStatus({ kind: 'error', message: errorMessage(cause) })
    }
  }

  if (accessConnections.length === 0) {
    return (
      <div className="empty-state">
        <Database size={30} />
        <span>还没有 Access 连接</span>
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
    !submitting && Boolean(connectionId) && Boolean(tableName) && Boolean(outputFile)

  return (
    <>
      <div className="toolbar">
        <span className="badge">Access → JSONL</span>
        <span className="badge">mdbtools</span>
      </div>

      <div className="migration-grid">
        <section className="section migration-section">
          <div className="section-heading">
            <h2>连接与表</h2>
            <span className="badge">Access</span>
          </div>
          <div className="migration-body">
            <div className="field">
              <label htmlFor="access-connection">连接</label>
              <div className="field-row">
                <select
                  id="access-connection"
                  value={connectionId}
                  onChange={(event) => {
                    setConnectionId(event.target.value)
                    setTestResult(null)
                    setOutputFile('')
                  }}
                >
                  <option value="">选择连接</option>
                  {accessConnections.map((connection) => (
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
                      <Check size={12} /> 已连接，{testResult.tables?.length ?? 0} 张表
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
              <label htmlFor="access-table">表</label>
              <div className="field-row">
                <select
                  id="access-table"
                  value={tableName}
                  onChange={(event) => setTableName(event.target.value)}
                  disabled={tables.length === 0}
                >
                  <option value="">
                    {loading
                      ? '正在读取表…'
                      : tables.length === 0
                        ? '没有可导出的表'
                        : '选择表'}
                  </option>
                  {tables.map((table) => (
                    <option key={table} value={table}>
                      {table}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={!connectionId || loading}
                  onClick={() => void loadTables()}
                >
                  {loading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                  刷新
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="section migration-section">
          <div className="section-heading">
            <h2>文件与选项</h2>
            <span className="badge">批次 JSONL</span>
          </div>
          <div className="migration-body">
            <div className="field">
              <label>导出文件</label>
              <div className="file-picker">
                <input
                  className="file-path"
                  value={outputFile}
                  readOnly
                  placeholder="选择输出文件"
                />
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={!tableName || submitting}
                  onClick={() => void chooseOutput()}
                >
                  <FolderOpen size={15} />
                  选择
                </button>
              </div>
            </div>

            <div className="field">
              <label htmlFor="access-batch-size">批量大小</label>
              <input
                id="access-batch-size"
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
              <span className="badge">{`每批 ${batchSize || 500} 行`}</span>
            </div>
          </div>
        </section>
      </div>
    </>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Access 操作失败'
}

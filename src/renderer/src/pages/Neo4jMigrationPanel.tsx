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
  ConnectionConfig,
  Neo4jConnectionTestResult,
  Neo4jExportRequest,
  Neo4jTableKind,
  ViewKey
} from '../../../shared/types'
import { validateNeo4jExportRequest } from '../../../shared/validation'

interface Neo4jMigrationPanelProps {
  connections: ConnectionConfig[]
  onNavigate: (view: ViewKey) => void
}

type Status =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string }

export function Neo4jMigrationPanel({
  connections,
  onNavigate
}: Neo4jMigrationPanelProps): ReactElement {
  const neo4jConnections = useMemo(
    () => connections.filter((connection) => connection.type === 'neo4j'),
    [connections]
  )
  const [connectionId, setConnectionId] = useState('')
  const [kind, setKind] = useState<Neo4jTableKind>('node')
  const [labels, setLabels] = useState<string[]>([])
  const [relationshipTypes, setRelationshipTypes] = useState<string[]>([])
  const [name, setName] = useState('')
  const [count, setCount] = useState<number | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<Neo4jConnectionTestResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [outputFile, setOutputFile] = useState('')
  const [batchSize, setBatchSize] = useState('500')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const selectedConnection =
    neo4jConnections.find((connection) => connection.id === connectionId) ?? null
  const choices = kind === 'node' ? labels : relationshipTypes

  useEffect(() => {
    setKind('node')
    setName('')
    setCount(null)
  }, [connectionId])

  async function loadCatalog(): Promise<void> {
    if (!connectionId) {
      return
    }
    setLoading(true)
    setStatus({ kind: 'idle' })
    try {
      const [nextLabels, nextTypes] = await Promise.all([
        window.api.neo4j.labels(connectionId),
        window.api.neo4j.relationshipTypes(connectionId)
      ])
      setLabels(nextLabels)
      setRelationshipTypes(nextTypes)
      const nextChoices = kind === 'node' ? nextLabels : nextTypes
      setName((current) => (nextChoices.includes(current) ? current : nextChoices[0] ?? ''))
    } catch (cause) {
      setStatus({ kind: 'error', message: errorMessage(cause) })
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
      setTestResult(await window.api.neo4j.test(connectionId))
    } catch (cause) {
      setTestResult({ ok: false, message: errorMessage(cause) })
    } finally {
      setTesting(false)
    }
  }

  async function loadCount(): Promise<void> {
    if (!connectionId || !name) {
      return
    }
    try {
      setCount(
        kind === 'node'
          ? await window.api.neo4j.countNodes({ connectionId, label: name })
          : await window.api.neo4j.countRelationships({ connectionId, type: name })
      )
    } catch (cause) {
      setStatus({ kind: 'error', message: errorMessage(cause) })
    }
  }

  async function chooseOutput(): Promise<void> {
    try {
      const prefix = kind === 'node' ? 'node' : 'relationship'
      const path = await window.api.dialog.chooseExportFile(
        `${prefix}.${name || 'export'}.jsonl`
      )
      if (path) {
        setOutputFile(path)
      }
    } catch (cause) {
      setStatus({ kind: 'error', message: errorMessage(cause) })
    }
  }

  async function startExport(): Promise<void> {
    const request: Neo4jExportRequest = {
      connectionId,
      kind,
      name,
      outputFile,
      batchSize: Number(batchSize)
    }
    const validation = validateNeo4jExportRequest(request)
    if (!validation.ok) {
      setStatus({ kind: 'error', message: validation.errors.join('；') })
      return
    }
    setStatus({ kind: 'submitting' })
    try {
      await window.api.tasks.create({
        type: 'neo4j-export',
        payload: validation.value
      })
      onNavigate('tasks')
    } catch (cause) {
      setStatus({ kind: 'error', message: errorMessage(cause) })
    }
  }

  if (neo4jConnections.length === 0) {
    return (
      <div className="empty-state">
        <Database size={30} />
        <span>还没有 Neo4j 连接</span>
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
    !submitting && Boolean(connectionId) && Boolean(name) && Boolean(outputFile)

  return (
    <>
      <div className="toolbar">
        <span className="badge">Graph → JSONL</span>
        <span className="badge">
          {selectedConnection?.uri ?? selectedConnection?.host ?? 'Bolt'}
        </span>
      </div>

      <div className="migration-grid">
        <section className="section migration-section">
          <div className="section-heading">
            <h2>连接与图对象</h2>
            <span className="badge">Neo4j</span>
          </div>
          <div className="migration-body">
            <div className="field">
              <label htmlFor="neo4j-connection">连接</label>
              <div className="field-row">
                <select
                  id="neo4j-connection"
                  value={connectionId}
                  onChange={(event) => {
                    setConnectionId(event.target.value)
                    setTestResult(null)
                    setLabels([])
                    setRelationshipTypes([])
                    setOutputFile('')
                  }}
                >
                  <option value="">选择连接</option>
                  {neo4jConnections.map((connection) => (
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
                      <Check size={12} /> {testResult.serverVersion ?? 'Neo4j'}
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
              <label>导出对象</label>
              <div className="segmented">
                <button
                  type="button"
                  className={kind === 'node' ? 'segment segment-active' : 'segment'}
                  onClick={() => {
                    setKind('node')
                    const next = labels[0] ?? ''
                    setName(next)
                    setCount(null)
                  }}
                >
                  节点标签
                </button>
                <button
                  type="button"
                  className={kind === 'relationship' ? 'segment segment-active' : 'segment'}
                  onClick={() => {
                    setKind('relationship')
                    const next = relationshipTypes[0] ?? ''
                    setName(next)
                    setCount(null)
                  }}
                >
                  关系类型
                </button>
              </div>
            </div>

            <div className="field">
              <label htmlFor="neo4j-name">
                {kind === 'node' ? '节点标签' : '关系类型'}
              </label>
              <div className="field-row">
                <select
                  id="neo4j-name"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value)
                    setCount(null)
                  }}
                  disabled={choices.length === 0}
                >
                  <option value="">
                    {loading
                      ? '正在加载…'
                      : choices.length === 0
                        ? '没有可导出的对象'
                        : '选择对象'}
                  </option>
                  {choices.map((choice) => (
                    <option key={choice} value={choice}>
                      {choice}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={!connectionId || loading}
                  onClick={() => void loadCatalog()}
                >
                  {loading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                  刷新目录
                </button>
              </div>
              {!labels.length && !relationshipTypes.length && connectionId ? (
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={loading}
                  onClick={() => void loadCatalog()}
                >
                  加载节点与关系
                </button>
              ) : null}
            </div>

            <div className="field-row">
              <button
                type="button"
                className="button button-secondary button-small"
                disabled={!name}
                onClick={() => void loadCount()}
              >
                统计数量
              </button>
              <span className="badge">
                {count === null ? '数量未加载' : `${count.toLocaleString()} 条`}
              </span>
            </div>
          </div>
        </section>

        <section className="section migration-section">
          <div className="section-heading">
            <h2>文件与选项</h2>
            <span className="badge">每行一条记录</span>
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
                  disabled={!name || submitting}
                  onClick={() => void chooseOutput()}
                >
                  <FolderOpen size={15} />
                  选择
                </button>
              </div>
            </div>

            <div className="field">
              <label htmlFor="neo4j-batch-size">页大小</label>
              <input
                id="neo4j-batch-size"
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
              <span className="badge">{`每页 ${batchSize || 500} 条`}</span>
            </div>
          </div>
        </section>
      </div>
    </>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Neo4j 操作失败'
}

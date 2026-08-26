import { useState } from 'react'
import type { ReactElement } from 'react'
import {
  ArrowRightLeft,
  CheckCircle2,
  Database,
  FileJson,
  FolderOpen,
  HardDriveDownload,
  HardDriveUpload,
  Layers,
  Loader2,
  PlugZap,
  RefreshCw,
  XCircle
} from 'lucide-react'

import type {
  ConnectionConfig,
  ElasticsearchConflictAction,
  ElasticsearchConnectionTestResult,
  ElasticsearchExportRequest,
  ElasticsearchImportRequest,
  ElasticsearchIndex,
  ElasticsearchMigrationResult,
  ElasticsearchReadStrategy,
  ViewKey
} from '../../../shared/types'
import {
  validateElasticsearchExportRequest,
  validateElasticsearchImportRequest
} from '../../../shared/validation'

interface ElasticsearchMigrationPanelProps {
  connections: ConnectionConfig[]
  onNavigate: (view: ViewKey) => void
}

type MigrationMode = 'export' | 'import'

export function ElasticsearchMigrationPanel({
  connections,
  onNavigate
}: ElasticsearchMigrationPanelProps): ReactElement {
  const elasticsearchConnections = connections.filter(
    (connection) => connection.type === 'elasticsearch'
  )
  const [mode, setMode] = useState<MigrationMode>('export')
  const [connectionId, setConnectionId] = useState('')
  const [indices, setIndices] = useState<ElasticsearchIndex[]>([])
  const [indexName, setIndexName] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] =
    useState<ElasticsearchConnectionTestResult | null>(null)
  const [loadingIndices, setLoadingIndices] = useState(false)
  const [filePath, setFilePath] = useState('')
  const [batchSize, setBatchSize] = useState('500')
  const [strategy, setStrategy] = useState<ElasticsearchReadStrategy>('scroll')
  const [onConflict, setOnConflict] = useState<ElasticsearchConflictAction>('skip')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ElasticsearchMigrationResult | null>(null)

  const selectedConnection =
    elasticsearchConnections.find((connection) => connection.id === connectionId) ?? null
  const selectedIndex = indices.find((index) => index.name === indexName) ?? null

  function changeMode(nextMode: MigrationMode): void {
    setMode(nextMode)
    setFilePath('')
    setResult(null)
    setError(null)
  }

  function selectConnection(nextConnectionId: string): void {
    setConnectionId(nextConnectionId)
    setIndices([])
    setIndexName('')
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
      const test = await window.api.elasticsearch.test(selectedConnection.id)
      setTestResult(test)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setTesting(false)
    }
  }

  async function handleLoadIndices(): Promise<void> {
    if (!selectedConnection) {
      setError('请先选择连接')
      return
    }
    setLoadingIndices(true)
    setError(null)
    try {
      const nextIndices = await window.api.elasticsearch.indices(selectedConnection.id)
      setIndices(nextIndices)
      setIndexName(nextIndices[0]?.name ?? '')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoadingIndices(false)
    }
  }

  async function handleChooseFile(): Promise<void> {
    try {
      if (mode === 'export') {
        const suggestedName = selectedIndex
          ? `${selectedIndex.name}.jsonl`
          : 'elasticsearch-export.jsonl'
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
    const request =
      mode === 'export'
        ? {
            connectionId,
            index: indexName,
            outputFile: filePath,
            batchSize: parsedBatchSize,
            strategy
          }
        : {
            connectionId,
            index: indexName,
            inputFile: filePath,
            batchSize: parsedBatchSize,
            onConflict
          }
    const validation =
      mode === 'export'
        ? validateElasticsearchExportRequest(request as ElasticsearchExportRequest)
        : validateElasticsearchImportRequest(request as ElasticsearchImportRequest)
    if (!validation.ok) {
      setError(validation.errors.join('；'))
      return
    }

    setRunning(true)
    setError(null)
    setResult(null)
    try {
      let nextResult: ElasticsearchMigrationResult | null = null
      if (mode === 'export' && validation.ok) {
        nextResult = await window.api.elasticsearch.export(
          validation.value as ElasticsearchExportRequest
        )
      } else if (mode === 'import' && validation.ok) {
        nextResult = await window.api.elasticsearch.import(
          validation.value as ElasticsearchImportRequest
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
    <div className="migration-engine">
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
        <span className="badge">
          {mode === 'export' ? 'scroll / search_after' : 'bulk'}
        </span>
      </div>

      {elasticsearchConnections.length === 0 ? (
        <div className="empty-state">
          <Database size={30} />
          <span>还没有 Elasticsearch 连接</span>
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
          <div className="migration-grid">
            <section className="section migration-section">
              <div className="section-heading">
                <h2>连接与索引</h2>
                <span className="badge">Elasticsearch</span>
              </div>
              <div className="migration-body">
                <div className="field-grid">
                  <div className="field">
                    <label htmlFor="elasticsearch-connection">连接</label>
                    <select
                      id="elasticsearch-connection"
                      value={connectionId}
                      onChange={(event) => selectConnection(event.target.value)}
                    >
                      <option value="">选择连接</option>
                      {elasticsearchConnections.map((connection) => (
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

                {testResult?.ok && testResult.supported === false ? (
                  <div className="inline-error">
                    Elasticsearch {testResult.serverVersion ?? ''} 低于 7.10.2，
                    search_after 导出可能不可用
                  </div>
                ) : null}

                <div className="field">
                  <label htmlFor="elasticsearch-index">索引</label>
                  <div className="field-row">
                    <select
                      id="elasticsearch-index"
                      value={indexName}
                      disabled={indices.length === 0}
                      onChange={(event) => setIndexName(event.target.value)}
                    >
                      {indices.length === 0 ? (
                        <option value="">先加载索引</option>
                      ) : (
                        indices.map((index) => (
                          <option key={index.name} value={index.name}>
                            {index.name}
                          </option>
                        ))
                      )}
                    </select>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={!selectedConnection || loadingIndices}
                      onClick={() => void handleLoadIndices()}
                    >
                      {loadingIndices ? (
                        <Loader2 className="spin" size={15} />
                      ) : (
                        <RefreshCw size={15} />
                      )}
                      加载索引
                    </button>
                  </div>
                </div>

                {selectedIndex ? (
                  <div className="table-summary">
                    <span className="table-summary-icon">
                      <Layers size={16} />
                    </span>
                    <span className="badge">
                      {selectedIndex.docsCount === null
                        ? '文档数未知'
                        : `${selectedIndex.docsCount.toLocaleString()} 文档`}
                    </span>
                    <span className="badge">{selectedIndex.fields.length} 字段</span>
                    <span className="badge">
                      {selectedIndex.storeSize ?? '大小未知'}
                    </span>
                    {selectedIndex.health ? (
                      <span className="badge">{selectedIndex.health}</span>
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
                    <label htmlFor="elasticsearch-batch-size">批量大小</label>
                    <input
                      id="elasticsearch-batch-size"
                      type="number"
                      min={1}
                      max={10000}
                      value={batchSize}
                      onChange={(event) => setBatchSize(event.target.value)}
                    />
                  </div>
                  {mode === 'export' ? (
                    <div className="field">
                      <label>读取方式</label>
                      <div className="segmented">
                        <button
                          type="button"
                          className={strategy === 'scroll' ? 'segment segment-active' : 'segment'}
                          onClick={() => setStrategy('scroll')}
                        >
                          Scroll
                        </button>
                        <button
                          type="button"
                          className={
                            strategy === 'search_after' ? 'segment segment-active' : 'segment'
                          }
                          onClick={() => setStrategy('search_after')}
                        >
                          Search After
                        </button>
                      </div>
                    </div>
                  ) : (
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
                          className={
                            onConflict === 'overwrite' ? 'segment segment-active' : 'segment'
                          }
                          onClick={() => setOnConflict('overwrite')}
                        >
                          覆盖
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="migration-action-row">
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={running || !selectedConnection || !selectedIndex || !filePath}
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
                    {batchSize ? `每批 ${batchSize} 条` : '每批 500 条'}
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
                    <span>处理</span>
                  </div>
                </div>
                {result.skipped !== undefined && result.skipped > 0 ? (
                  <div className="result-item">
                    <XCircle size={18} />
                    <div>
                      <strong>{result.skipped.toLocaleString()}</strong>
                      <span>跳过</span>
                    </div>
                  </div>
                ) : null}
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

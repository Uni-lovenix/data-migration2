import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import {
  ArrowRightLeft,
  Check,
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
  Search,
  XCircle
} from 'lucide-react'

import type {
  ConnectionConfig,
  DirectConflictPolicy,
  ElasticsearchConflictAction,
  ElasticsearchConnectionTestResult,
  ElasticsearchDirectRequest,
  ElasticsearchExportRequest,
  ElasticsearchImportRequest,
  ElasticsearchIndex,
  ElasticsearchMirrorArchiveRequest,
  ElasticsearchMirrorRequest,
  ElasticsearchMirrorRestoreRequest,
  ElasticsearchMigrationResult,
  ElasticsearchReadStrategy,
  FieldTransform,
  RiskAck,
  RollbackConflictPolicy,
  RollbackPolicy,
  ViewKey
} from '../../../shared/types'
import {
  validateElasticsearchDirectRequest,
  validateElasticsearchExportRequest,
  validateElasticsearchImportRequest,
  validateElasticsearchMirrorArchiveRequest,
  validateElasticsearchMirrorRequest,
  validateElasticsearchMirrorRestoreRequest
} from '../../../shared/validation'
import {
  directMigrationRiskNotice,
  mirrorArchiveRiskNotice,
  RISK_NOTICE_VERSION
} from '../../../shared/risk-notices'
import { RiskConfirmDialog } from '../components/RiskConfirmDialog'
import { ColumnSelection } from '../components/ColumnSelection'
import { FieldTransformsEditor } from '../components/FieldTransformsEditor'

interface ElasticsearchMigrationPanelProps {
  connections: ConnectionConfig[]
  onNavigate: (view: ViewKey) => void
}

type MigrationMode = 'export' | 'import' | 'direct' | 'mirror' | 'archive' | 'restore'
type MappingSource = 'sidecar' | 'inline' | 'auto'

export function ElasticsearchMigrationPanel({
  connections,
  onNavigate
}: ElasticsearchMigrationPanelProps): ReactElement {
  const elasticsearchConnections = connections.filter(
    (connection) => connection.type === 'elasticsearch'
  )
  const hdfsConnections = connections.filter((connection) => connection.type === 'hdfs')
  const [mode, setMode] = useState<MigrationMode>('export')
  const [connectionId, setConnectionId] = useState('')
  const [indices, setIndices] = useState<ElasticsearchIndex[]>([])
  const [indexName, setIndexName] = useState('')
  // 导入目标索引名：允许自定义（含不存在的索引），与左侧浏览选择解耦。
  const [targetIndex, setTargetIndex] = useState('')
  const [indexSearch, setIndexSearch] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] =
    useState<ElasticsearchConnectionTestResult | null>(null)
  const [loadingIndices, setLoadingIndices] = useState(false)
  const [filePath, setFilePath] = useState('')
  const [batchSize, setBatchSize] = useState('500')
  const [concurrency, setConcurrency] = useState('4')
  const [strategy, setStrategy] = useState<ElasticsearchReadStrategy>('scroll')
  const [onConflict, setOnConflict] = useState<ElasticsearchConflictAction>('skip')
  const [query, setQuery] = useState('')
  const [exportMapping, setExportMapping] = useState(true)
  const [createIndex, setCreateIndex] = useState(true)
  const [mappingSource, setMappingSource] = useState<MappingSource>('sidecar')
  const [inlineMapping, setInlineMapping] = useState('')
  const [generatingSchema, setGeneratingSchema] = useState(false)
  const [selectedColumns, setSelectedColumns] = useState<string[]>([])
  const [fieldTransforms, setFieldTransforms] = useState<FieldTransform[]>([])
  const [detectedSidecar, setDetectedSidecar] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ElasticsearchMigrationResult | null>(null)
  // 直连迁移状态
  const [targetConnectionId, setTargetConnectionId] = useState('')
  const [directConflict, setDirectConflict] = useState<DirectConflictPolicy>('skip')
  const [rollbackOn, setRollbackOn] = useState<RollbackPolicy>('failure-or-cancel')
  const [rollbackConflictPolicy, setRollbackConflictPolicy] =
    useState<RollbackConflictPolicy>('abort')
  const [pendingDirect, setPendingDirect] = useState<ElasticsearchDirectRequest | null>(null)
  const [riskBusy, setRiskBusy] = useState(false)
  const [riskError, setRiskError] = useState<string | null>(null)
  // 镜像迁移（同索引）
  const [mirrorCreateTarget, setMirrorCreateTarget] = useState(true)
  const [mirrorRequireMapping, setMirrorRequireMapping] = useState(true)
  const [mirrorCopyAliases, setMirrorCopyAliases] = useState(false)
  const [mirrorDropCreated, setMirrorDropCreated] = useState(true)
  const [pendingMirror, setPendingMirror] = useState<ElasticsearchMirrorRequest | null>(null)
  // HDFS 镜像存档
  const [hdfsConnectionId, setHdfsConnectionId] = useState('')
  const [archiveDirectory, setArchiveDirectory] = useState('')
  const [archivePartSize, setArchivePartSize] = useState('20000')
  const [archiveExisting, setArchiveExisting] = useState<'fail' | 'overwrite'>('fail')
  const [archiveCleanup, setArchiveCleanup] = useState(true)
  const [hdfsTest, setHdfsTest] = useState<{ ok: boolean; message?: string } | null>(null)
  const [pendingArchive, setPendingArchive] = useState<ElasticsearchMirrorArchiveRequest | null>(
    null
  )
  // HDFS 存档恢复
  const [restoreVerify, setRestoreVerify] = useState(true)
  const [restoreDropCreated, setRestoreDropCreated] = useState(true)
  const [pendingRestore, setPendingRestore] =
    useState<ElasticsearchMirrorRestoreRequest | null>(null)

  const selectedConnection =
    elasticsearchConnections.find((connection) => connection.id === connectionId) ?? null
  const selectedIndex = indices.find((index) => index.name === indexName) ?? null
  const importTargetIndex = targetIndex.trim()
  const targetIndexExists = indices.some((index) => index.name === importTargetIndex)
  const visibleIndices = useMemo(() => {
    const keyword = indexSearch.trim().toLowerCase()
    return keyword
      ? indices.filter((index) => index.name.toLowerCase().includes(keyword))
      : indices
  }, [indexSearch, indices])

  function changeMode(nextMode: MigrationMode): void {
    setMode(nextMode)
    setFilePath('')
    setDetectedSidecar(null)
    setResult(null)
    setError(null)
    setSelectedColumns([])
    setFieldTransforms([])
    setTargetIndex(nextMode === 'import' ? indexName : '')
  }

  useEffect(() => {
    if (mode !== 'import' || !filePath) {
      setDetectedSidecar(null)
      return
    }
    let cancelled = false
    const candidate = `${filePath}.mapping.json`
    window.api.fs
      .exists(candidate)
      .then((exists) => {
        if (cancelled) {
          return
        }
        setDetectedSidecar(exists ? candidate : null)
      })
      .catch(() => {
        if (cancelled) {
          return
        }
        setDetectedSidecar(null)
      })
    return () => {
      cancelled = true
    }
  }, [mode, filePath])

  function selectConnection(nextConnectionId: string): void {
    setConnectionId(nextConnectionId)
    setIndices([])
    setIndexName('')
    setTargetIndex('')
    setIndexSearch('')
    setTestResult(null)
    setResult(null)
    setError(null)
    setSelectedColumns([])
    setFieldTransforms([])
  }

  function selectIndex(nextIndexName: string): void {
    setIndexName(nextIndexName)
    setTargetIndex(nextIndexName)
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
      const first = nextIndices[0]?.name ?? ''
      setIndexName(first)
      setTargetIndex((current) => current.trim().length > 0 ? current : first)
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
          setSelectedColumns([])
          setFieldTransforms([])
        }
      } else {
        const path = await window.api.dialog.chooseImportFile()
        if (path) {
          setFilePath(path)
          setSelectedColumns([])
          setFieldTransforms([])
        }
      }
      setError(null)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function handleLoadSidecarMapping(): Promise<void> {
    if (mappingSource !== 'inline' || !detectedSidecar) {
      return
    }
    try {
      const content = await window.api.fs.readText(detectedSidecar)
      setInlineMapping(content)
      setMappingSource('inline')
      setError(null)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function handleGenerateMapping(): Promise<void> {
    const target = importTargetIndex.length > 0 ? importTargetIndex : selectedIndex?.name ?? ''
    if (!filePath.trim() || target.length === 0) {
      setError('请先选择导入文件和目标索引')
      return
    }
    setGeneratingSchema(true)
    setError(null)
    try {
      const inferred = await window.api.schema.infer({
        inputFile: filePath.trim(),
        engine: 'elasticsearch',
        table: target,
        sampleSize: 1000
      })
      setInlineMapping(inferred.definition)
      setMappingSource('inline')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setGeneratingSchema(false)
    }
  }

  async function handleStart(): Promise<void> {
    if (mode === 'direct') {
      await prepareDirectMigration()
      return
    }
    if (mode === 'mirror') {
      await prepareMirror()
      return
    }
    if (mode === 'archive') {
      await prepareArchive()
      return
    }
    if (mode === 'restore') {
      await prepareRestore()
      return
    }
    const parsedBatchSize = Number(batchSize)
    const parsedConcurrency = Number(concurrency)
    const trimmedQuery = query.trim()
    const trimmedInlineMapping = inlineMapping.trim()
    const fallbackSidecar = `${filePath}.mapping.json`
    const request =
      mode === 'export'
        ? {
            connectionId,
            index: indexName,
            outputFile: filePath,
            batchSize: parsedBatchSize,
            concurrency: parsedConcurrency,
            strategy,
            ...(trimmedQuery.length > 0 ? { query: trimmedQuery } : {}),
            exportMapping
          }
        : {
            connectionId,
            index: importTargetIndex,
            inputFile: filePath,
            batchSize: parsedBatchSize,
            concurrency: parsedConcurrency,
            onConflict,
            createIndex,
            mapping:
              mappingSource === 'inline'
                ? { source: 'inline', inlineJson: trimmedInlineMapping }
                : mappingSource === 'auto'
                  ? { source: 'auto' }
                  : { source: 'sidecar', sidecarPath: detectedSidecar ?? fallbackSidecar },
            ...(selectedColumns.length > 0 ? { selectedColumns } : {}),
            ...(fieldTransforms.length > 0 ? { fieldTransforms } : {})
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
      await window.api.tasks.create({
        type: mode === 'export' ? 'elasticsearch-export' : 'elasticsearch-import',
        payload:
          mode === 'export'
            ? (validation.value as ElasticsearchExportRequest)
            : (validation.value as ElasticsearchImportRequest)
      })
      onNavigate('tasks')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setRunning(false)
    }
  }

  /**
   * 直连迁移：先做两端预检与参数校验，再弹出风险确认对话框。
   * 只有用户确认后才会创建任务。
   */
  async function prepareDirectMigration(): Promise<void> {
    const target = elasticsearchConnections.find(
      (connection) => connection.id === targetConnectionId
    )
    if (!selectedConnection || !target) {
      setError('请选择源连接和目标连接')
      return
    }
    if (!indexName) {
      setError('请选择要迁移的源索引')
      return
    }
    const targetIndexName = targetIndex.trim() || indexName

    const [sourceTest, targetTest] = await Promise.all([
      window.api.elasticsearch.test(selectedConnection.id),
      window.api.elasticsearch.test(target.id)
    ])
    if (!sourceTest.ok) {
      setError(`源集群预检失败：${sourceTest.message ?? '连接失败'}`)
      return
    }
    if (!targetTest.ok) {
      setError(`目标集群预检失败：${targetTest.message ?? '连接失败'}`)
      return
    }

    const request: ElasticsearchDirectRequest = {
      connectionId: selectedConnection.id,
      index: indexName,
      targetConnectionId: target.id,
      targetIndex: targetIndexName,
      batchSize: Number(batchSize),
      conflictPolicy: directConflict,
      rollbackOn,
      rollbackConflictPolicy,
      strategy,
      ...(query.trim().length > 0 ? { query: query.trim() } : {}),
      riskAck: currentRiskAck()
    }
    const validation = validateElasticsearchDirectRequest(request)
    if (!validation.ok) {
      setError(validation.errors.join('；'))
      return
    }
    setPendingDirect(validation.value)
  }

  /** 风险确认通过后创建直连迁移任务。 */
  /** 同索引镜像迁移：预检两端集群并准备风险确认。 */
  async function prepareMirror(): Promise<void> {
    const target = elasticsearchConnections.find(
      (connection) => connection.id === targetConnectionId
    )
    if (!selectedConnection || !target) {
      setError('请选择源连接和目标连接')
      return
    }
    if (!indexName) {
      setError('请选择要镜像的索引')
      return
    }
    const [sourceTest, targetTest] = await Promise.all([
      window.api.elasticsearch.test(selectedConnection.id),
      window.api.elasticsearch.test(target.id)
    ])
    if (!sourceTest.ok) {
      setError(`源集群预检失败：${sourceTest.message ?? '连接失败'}`)
      return
    }
    if (!targetTest.ok) {
      setError(`目标集群预检失败：${targetTest.message ?? '连接失败'}`)
      return
    }

    const request: ElasticsearchMirrorRequest = {
      connectionId: selectedConnection.id,
      index: indexName,
      targetConnectionId: target.id,
      batchSize: Number(batchSize),
      conflictPolicy: directConflict,
      createTargetIndex: mirrorCreateTarget,
      requireMappingMatch: mirrorRequireMapping,
      copyAliases: mirrorCopyAliases,
      dropCreatedTarget: mirrorDropCreated,
      rollbackOn,
      rollbackConflictPolicy,
      strategy,
      ...(query.trim().length > 0 ? { query: query.trim() } : {}),
      riskAck: currentRiskAck()
    }
    const validation = validateElasticsearchMirrorRequest(request)
    if (!validation.ok) {
      setError(validation.errors.join('；'))
      return
    }
    setPendingMirror(validation.value)
  }

  /** HDFS 镜像存档：预检 ES 与 HDFS 并准备风险确认。 */
  async function prepareArchive(): Promise<void> {
    const hdfsConnection = hdfsConnections.find(
      (connection) => connection.id === hdfsConnectionId
    )
    if (!selectedConnection || !hdfsConnection) {
      setError('请选择源集群和 HDFS 连接')
      return
    }
    if (!indexName) {
      setError('请选择要存档的索引')
      return
    }
    const directory = archiveDirectory.trim() || hdfsConnection.basePath || ''

    const [sourceTest, hdfsResult] = await Promise.all([
      window.api.elasticsearch.test(selectedConnection.id),
      // 预检 HDFS 基础目录（存档目录本身允许不存在，由任务创建）。
      window.api.hdfs.test(hdfsConnection.id, hdfsConnection.basePath || '/')
    ])
    setHdfsTest(hdfsResult)
    if (!sourceTest.ok) {
      setError(`源集群预检失败：${sourceTest.message ?? '连接失败'}`)
      return
    }
    if (!hdfsResult.ok) {
      setError(`HDFS 预检失败：${hdfsResult.message ?? '连接失败'}`)
      return
    }

    const request: ElasticsearchMirrorArchiveRequest = {
      connectionId: selectedConnection.id,
      index: indexName,
      hdfsConnectionId: hdfsConnection.id,
      hdfsDirectory: directory,
      partSize: Number(archivePartSize),
      existing: archiveExisting,
      cleanupOnFailure: archiveCleanup,
      strategy,
      ...(query.trim().length > 0 ? { query: query.trim() } : {}),
      riskAck: currentRiskAck()
    }
    const validation = validateElasticsearchMirrorArchiveRequest(request)
    if (!validation.ok) {
      setError(validation.errors.join('；'))
      return
    }
    setPendingArchive(validation.value)
  }

  /** HDFS 存档恢复：预检 HDFS 与目标集群并准备风险确认。 */
  async function prepareRestore(): Promise<void> {
    const hdfsConnection = hdfsConnections.find(
      (connection) => connection.id === hdfsConnectionId
    )
    const target = elasticsearchConnections.find(
      (connection) => connection.id === connectionId
    )
    if (!hdfsConnection || !target) {
      setError('请选择目标集群和 HDFS 连接')
      return
    }
    const directory = archiveDirectory.trim() || hdfsConnection.basePath || ''
    if (!directory) {
      setError('请填写 HDFS 存档目录')
      return
    }

    const [hdfsResult, targetTest] = await Promise.all([
      window.api.hdfs.test(hdfsConnection.id, directory),
      window.api.elasticsearch.test(target.id)
    ])
    setHdfsTest(hdfsResult)
    if (!hdfsResult.ok) {
      setError(`HDFS 存档不可读：${hdfsResult.message ?? '路径不存在'}`)
      return
    }
    if (!targetTest.ok) {
      setError(`目标集群预检失败：${targetTest.message ?? '连接失败'}`)
      return
    }

    const request: ElasticsearchMirrorRestoreRequest = {
      hdfsConnectionId: hdfsConnection.id,
      hdfsDirectory: directory,
      targetConnectionId: target.id,
      ...(indexName ? { targetIndex: indexName } : {}),
      batchSize: Number(batchSize),
      conflictPolicy: directConflict,
      createTargetIndex: true,
      verifyChecksums: restoreVerify,
      dropCreatedTarget: restoreDropCreated,
      rollbackOn,
      rollbackConflictPolicy,
      riskAck: currentRiskAck()
    }
    const validation = validateElasticsearchMirrorRestoreRequest(request)
    if (!validation.ok) {
      setError(validation.errors.join('；'))
      return
    }
    setPendingRestore(validation.value)
  }

  async function confirmRestoreRisk(): Promise<void> {
    if (!pendingRestore) {
      return
    }
    setRiskBusy(true)
    setRiskError(null)
    try {
      await window.api.tasks.create({
        type: 'elasticsearch-mirror-restore',
        payload: { ...pendingRestore, riskAck: currentRiskAck() }
      })
      setPendingRestore(null)
      onNavigate('tasks')
    } catch (cause) {
      setRiskError(errorMessage(cause))
    } finally {
      setRiskBusy(false)
    }
  }

  async function confirmMirrorRisk(): Promise<void> {
    if (!pendingMirror) {
      return
    }
    setRiskBusy(true)
    setRiskError(null)
    try {
      await window.api.tasks.create({
        type: 'elasticsearch-mirror',
        payload: { ...pendingMirror, riskAck: currentRiskAck() }
      })
      setPendingMirror(null)
      onNavigate('tasks')
    } catch (cause) {
      setRiskError(errorMessage(cause))
    } finally {
      setRiskBusy(false)
    }
  }

  async function confirmArchiveRisk(): Promise<void> {
    if (!pendingArchive) {
      return
    }
    setRiskBusy(true)
    setRiskError(null)
    try {
      await window.api.tasks.create({
        type: 'elasticsearch-mirror-archive',
        payload: { ...pendingArchive, riskAck: currentRiskAck() }
      })
      setPendingArchive(null)
      onNavigate('tasks')
    } catch (cause) {
      setRiskError(errorMessage(cause))
    } finally {
      setRiskBusy(false)
    }
  }

  async function confirmDirectRisk(): Promise<void> {
    if (!pendingDirect) {
      return
    }
    setRiskBusy(true)
    setRiskError(null)
    try {
      await window.api.tasks.create({
        type: 'elasticsearch-direct',
        payload: { ...pendingDirect, riskAck: currentRiskAck() }
      })
      setPendingDirect(null)
      onNavigate('tasks')
    } catch (cause) {
      setRiskError(errorMessage(cause))
    } finally {
      setRiskBusy(false)
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
          <button
            type="button"
            className={mode === 'direct' ? 'segment segment-active' : 'segment'}
            onClick={() => changeMode('direct')}
          >
            <ArrowRightLeft size={15} />
            直连迁移
          </button>
          <button
            type="button"
            className={mode === 'mirror' ? 'segment segment-active' : 'segment'}
            onClick={() => changeMode('mirror')}
          >
            <Layers size={15} />
            镜像迁移
          </button>
          <button
            type="button"
            className={mode === 'archive' ? 'segment segment-active' : 'segment'}
            onClick={() => changeMode('archive')}
          >
            <Layers size={15} />
            镜像存档
          </button>
          <button
            type="button"
            className={mode === 'restore' ? 'segment segment-active' : 'segment'}
            onClick={() => changeMode('restore')}
          >
            <FolderOpen size={15} />
            存档恢复
          </button>
        </div>
        <span className="badge">
          {mode === 'export'
            ? 'scroll / search_after'
            : mode === 'import'
              ? 'bulk'
              : mode === 'direct'
                ? '索引 → 索引（不过本地文件）'
                : mode === 'mirror'
                  ? '跨集群同名索引镜像（含 schema）'
                  : mode === 'archive'
                    ? '索引镜像写入 HDFS'
                    : 'HDFS 镜像恢复到目标集群'}
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
                  <div className="index-field-header">
                    <label htmlFor="elasticsearch-index-search">
                      {mode === 'restore'
                        ? '目标索引（留空 = 用存档内索引名）'
                        : mode === 'import'
                          ? '目标索引'
                          : '索引'}
                    </label>
                    {indices.length > 0 ? (
                      <span className="field-hint">
                        {indexSearch.trim().length > 0
                          ? `${visibleIndices.length} 个匹配 / 共 ${indices.length} 个`
                          : `共 ${indices.length} 个`}
                      </span>
                    ) : null}
                  </div>
                  <div className="field-row">
                    <div className="search-box table-search">
                      <Search size={14} />
                      <input
                        id="elasticsearch-index-search"
                        type="search"
                        value={indexSearch}
                        disabled={indices.length === 0}
                        onChange={(event) => setIndexSearch(event.target.value)}
                        placeholder={indices.length === 0 ? '先加载索引' : '搜索索引名称'}
                        aria-label="搜索 Elasticsearch 索引"
                        autoComplete="off"
                      />
                    </div>
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
                  <div
                    className="index-picker"
                    role="listbox"
                    aria-label="Elasticsearch 索引列表"
                  >
                    {indices.length === 0 ? (
                      <div className="index-picker-empty">先加载索引</div>
                    ) : visibleIndices.length === 0 ? (
                      <div className="index-picker-empty">没有匹配的索引</div>
                    ) : (
                      visibleIndices.map((index) => {
                        const selected = index.name === indexName
                        return (
                          <button
                            key={index.name}
                            type="button"
                            className={
                              selected
                                ? 'index-picker-row index-picker-row-selected'
                                : 'index-picker-row'
                            }
                            role="option"
                            aria-selected={selected}
                            onClick={() => selectIndex(index.name)}
                          >
                            <span className="index-picker-check" aria-hidden="true">
                              {selected ? <Check size={15} /> : null}
                            </span>
                            <span className="index-picker-name" title={index.name}>
                              {index.name}
                            </span>
                            <span className="badge">
                              {index.docsCount === null
                                ? '文档数未知'
                                : `${index.docsCount.toLocaleString()} 文档`}
                            </span>
                          </button>
                        )
                      })
                    )}
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
                <h2>
                  {mode === 'direct' || mode === 'mirror'
                    ? '目标与回滚策略'
                    : mode === 'archive'
                      ? 'HDFS 存档位置'
                      : '文件与选项'}
                </h2>
                <span className="badge">
                  {mode === 'direct'
                    ? '直连'
                    : mode === 'mirror'
                      ? '镜像'
                      : mode === 'archive'
                        ? 'HDFS'
                        : '批量'}
                </span>
              </div>
              <div className="migration-body">
                {mode === 'direct' ? (
                  <div className="direct-summary">
                    <span>
                      <strong>源：</strong>
                      {selectedConnection?.name ?? '未选择'} / {indexName || '未选择索引'}
                    </span>
                    <span>
                      <strong>目标：</strong>
                      {elasticsearchConnections.find(
                        (connection) => connection.id === targetConnectionId
                      )?.name ?? '未选择'}{' '}
                      / {targetIndex.trim() || indexName || '未填写目标索引'}
                    </span>
                    <span>
                      文档直接 bulk 写入目标索引，本地只保留进度与撤销日志，不生成数据文件。
                    </span>
                  </div>
                ) : null}

                {mode === 'direct' || mode === 'mirror' ? (
                  <>
                    <div className="field-grid">
                      <div className="field">
                        <label htmlFor="elasticsearch-target-connection">目标连接</label>
                        <select
                          id="elasticsearch-target-connection"
                          value={targetConnectionId}
                          onChange={(event) => setTargetConnectionId(event.target.value)}
                        >
                          <option value="">选择目标连接</option>
                          {elasticsearchConnections.map((connection) => (
                            <option key={connection.id} value={connection.id}>
                              {connection.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor="elasticsearch-target-index-direct">目标索引</label>
                        <input
                          id="elasticsearch-target-index-direct"
                          value={targetIndex}
                          onChange={(event) => setTargetIndex(event.target.value)}
                          placeholder={selectedIndex ? selectedIndex.name : '例如 products_copy'}
                          autoComplete="off"
                        />
                        <span className="hint">
                          目标索引必须已存在且可写；直连迁移暂不自动创建索引。
                        </span>
                      </div>
                    </div>
                  </>
                ) : null}

                {mode === 'mirror' ? (
                  <>
                    <div className="direct-summary">
                      <span>
                        <strong>镜像：</strong>
                        {selectedConnection?.name ?? '未选择'} / {indexName || '未选择索引'} →{' '}
                        {elasticsearchConnections.find(
                          (connection) => connection.id === targetConnectionId
                        )?.name ?? '未选择目标集群'}{' '}
                        / <code>{indexName || '同名索引'}</code>
                      </span>
                      <span>
                        目标索引名与源一致；不存在时按源 settings / mappings 创建，数据直接 bulk
                        写入，不过本地文件。
                      </span>
                    </div>
                    <div className="field">
                      <label htmlFor="elasticsearch-mirror-target-connection">目标集群</label>
                      <select
                        id="elasticsearch-mirror-target-connection"
                        value={targetConnectionId}
                        onChange={(event) => setTargetConnectionId(event.target.value)}
                      >
                        <option value="">选择目标连接</option>
                        {elasticsearchConnections.map((connection) => (
                          <option key={connection.id} value={connection.id}>
                            {connection.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={mirrorCreateTarget}
                        onChange={(event) => setMirrorCreateTarget(event.target.checked)}
                      />
                      <span>目标索引不存在时按源定义创建（settings / mappings）</span>
                    </label>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={mirrorRequireMapping}
                        onChange={(event) => setMirrorRequireMapping(event.target.checked)}
                      />
                      <span>目标已存在时校验字段类型一致（不一致直接失败）</span>
                    </label>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={mirrorCopyAliases}
                        onChange={(event) => setMirrorCopyAliases(event.target.checked)}
                      />
                      <span>复制源索引别名到目标（跳过系统别名）</span>
                    </label>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={mirrorDropCreated}
                        onChange={(event) => setMirrorDropCreated(event.target.checked)}
                      />
                      <span>回滚时删除本次创建的目标索引</span>
                    </label>
                  </>
                ) : null}

                {mode === 'archive' ? (
                  <>
                    {hdfsConnections.length === 0 ? (
                      <div className="inline-error">
                        还没有 HDFS 连接，请先到「连接」页新增（WebHDFS，默认端口 9870）。
                      </div>
                    ) : null}
                    <div className="field-grid">
                      <div className="field">
                        <label htmlFor="elasticsearch-archive-hdfs">HDFS 连接</label>
                        <select
                          id="elasticsearch-archive-hdfs"
                          value={hdfsConnectionId}
                          onChange={(event) => {
                            setHdfsConnectionId(event.target.value)
                            setHdfsTest(null)
                          }}
                        >
                          <option value="">选择 HDFS 连接</option>
                          {hdfsConnections.map((connection) => (
                            <option key={connection.id} value={connection.id}>
                              {connection.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor="elasticsearch-archive-directory">存档目录</label>
                        <input
                          id="elasticsearch-archive-directory"
                          value={archiveDirectory}
                          onChange={(event) => setArchiveDirectory(event.target.value)}
                          placeholder={
                            hdfsConnections.find((c) => c.id === hdfsConnectionId)?.basePath ??
                            '/data-mirrors'
                          }
                          autoComplete="off"
                        />
                      </div>
                    </div>
                    <div className="field-grid">
                      <div className="field">
                        <label htmlFor="elasticsearch-archive-part-size">分片文档数</label>
                        <input
                          id="elasticsearch-archive-part-size"
                          type="number"
                          min={100}
                          max={200000}
                          value={archivePartSize}
                          onChange={(event) => setArchivePartSize(event.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="elasticsearch-archive-existing">目录已存在</label>
                        <select
                          id="elasticsearch-archive-existing"
                          value={archiveExisting}
                          onChange={(event) =>
                            setArchiveExisting(event.target.value as 'fail' | 'overwrite')
                          }
                        >
                          <option value="fail">失败即停（不覆盖）</option>
                          <option value="overwrite">删除后重建</option>
                        </select>
                      </div>
                    </div>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={archiveCleanup}
                        onChange={(event) => setArchiveCleanup(event.target.checked)}
                      />
                      <span>失败或取消时删除本次写入的 HDFS 目录</span>
                    </label>
                    {hdfsTest ? (
                      <span className={`badge ${hdfsTest.ok ? 'badge-ok' : 'badge-error'}`}>
                        {hdfsTest.ok ? 'HDFS 可达' : hdfsTest.message ?? 'HDFS 不可达'}
                      </span>
                    ) : null}
                  </>
                ) : null}

                {mode === 'restore' ? (
                  <>
                    {hdfsConnections.length === 0 ? (
                      <div className="inline-error">
                        还没有 HDFS 连接，请先到「连接」页新增（WebHDFS，默认端口 9870）。
                      </div>
                    ) : null}
                    <div className="direct-summary">
                      <span>
                        <strong>来源：</strong>
                        HDFS{' '}
                        {hdfsConnections.find((c) => c.id === hdfsConnectionId)?.name ??
                          '未选择'}
                        :
                        {archiveDirectory.trim() ||
                          hdfsConnections.find((c) => c.id === hdfsConnectionId)?.basePath ||
                          '/'}
                      </span>
                      <span>
                        <strong>目标：</strong>
                        {selectedConnection?.name ?? '未选择集群'} /{' '}
                        {indexName || '存档内索引名'}
                      </span>
                      <span>请从左侧选择目标集群；目标索引可留空以使用存档内的索引名。</span>
                    </div>
                    <div className="field-grid">
                      <div className="field">
                        <label htmlFor="elasticsearch-restore-hdfs">HDFS 连接</label>
                        <select
                          id="elasticsearch-restore-hdfs"
                          value={hdfsConnectionId}
                          onChange={(event) => {
                            setHdfsConnectionId(event.target.value)
                            setHdfsTest(null)
                          }}
                        >
                          <option value="">选择 HDFS 连接</option>
                          {hdfsConnections.map((connection) => (
                            <option key={connection.id} value={connection.id}>
                              {connection.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor="elasticsearch-restore-directory">存档目录</label>
                        <input
                          id="elasticsearch-restore-directory"
                          value={archiveDirectory}
                          onChange={(event) => setArchiveDirectory(event.target.value)}
                          placeholder="/data-mirrors/my-index"
                          autoComplete="off"
                        />
                      </div>
                    </div>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={restoreVerify}
                        onChange={(event) => setRestoreVerify(event.target.checked)}
                      />
                      <span>校验分片 md5 与行数（推荐）</span>
                    </label>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={restoreDropCreated}
                        onChange={(event) => setRestoreDropCreated(event.target.checked)}
                      />
                      <span>回滚时删除本次创建的目标索引</span>
                    </label>
                    {hdfsTest ? (
                      <span className={`badge ${hdfsTest.ok ? 'badge-ok' : 'badge-error'}`}>
                        {hdfsTest.ok ? '存档可读' : hdfsTest.message ?? '存档不可读'}
                      </span>
                    ) : null}
                  </>
                ) : null}

                {mode === 'import' ? (
                  <div className="field">
                    <label htmlFor="elasticsearch-target-index">
                      目标索引名称
                      <span className="hint">可自定义；不存在时按下方的 mapping 来源初始化</span>
                    </label>
                    <input
                      id="elasticsearch-target-index"
                      value={targetIndex}
                      onChange={(event) => setTargetIndex(event.target.value)}
                      placeholder={selectedIndex ? selectedIndex.name : '例如 products_copy'}
                      autoComplete="off"
                    />
                    {importTargetIndex.length > 0 ? (
                      <span className="hint">
                        {targetIndexExists
                          ? `目标索引 ${importTargetIndex} 已存在，将直接写入（mapping 来源不生效）`
                          : `目标索引 ${importTargetIndex} 不存在，将按 mapping 来源自动创建`}
                      </span>
                    ) : (
                      <span className="hint">
                        留空时使用左侧列表中选中的索引；也可直接输入新名称
                      </span>
                    )}
                  </div>
                ) : null}
                {mode === 'direct' ||
                mode === 'mirror' ||
                mode === 'archive' ||
                mode === 'restore' ? null : (
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
                )}

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
                  <div
                    className="field"
                    hidden={
                      mode === 'direct' ||
                      mode === 'mirror' ||
                      mode === 'archive' ||
                      mode === 'restore'
                    }
                  >
                    <label htmlFor="elasticsearch-concurrency">并发度</label>
                    <input
                      id="elasticsearch-concurrency"
                      type="number"
                      min={1}
                      max={32}
                      value={concurrency}
                      onChange={(event) => setConcurrency(event.target.value)}
                    />
                  </div>
                  {mode !== 'import' && mode !== 'restore' ? (
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

                {mode === 'direct' || mode === 'mirror' || mode === 'restore' ? (
                  <>
                    <div className="field-grid">
                      <div className="field">
                        <label>冲突处理</label>
                        <div className="segmented">
                          <button
                            type="button"
                            className={
                              directConflict === 'skip' ? 'segment segment-active' : 'segment'
                            }
                            onClick={() => setDirectConflict('skip')}
                          >
                            跳过已存在
                          </button>
                          <button
                            type="button"
                            className={
                              directConflict === 'overwrite'
                                ? 'segment segment-active'
                                : 'segment'
                            }
                            onClick={() => setDirectConflict('overwrite')}
                          >
                            覆盖写入
                          </button>
                        </div>
                      </div>
                      <div className="field">
                        <label htmlFor="elasticsearch-rollback-on">回滚策略</label>
                        <select
                          id="elasticsearch-rollback-on"
                          value={rollbackOn}
                          onChange={(event) =>
                            setRollbackOn(event.target.value as RollbackPolicy)
                          }
                        >
                          <option value="failure-or-cancel">
                            失败或取消时自动回滚（会删除已写入文档）
                          </option>
                          <option value="failure">仅失败时自动回滚</option>
                          <option value="manual">只记录撤销日志，手动回滚</option>
                          <option value="none">不记录撤销日志（失败后无法回滚）</option>
                        </select>
                      </div>
                    </div>
                    <div className="field">
                      <label htmlFor="elasticsearch-rollback-conflict">
                        回滚遇到第三方修改
                      </label>
                      <select
                        id="elasticsearch-rollback-conflict"
                        value={rollbackConflictPolicy}
                        onChange={(event) =>
                          setRollbackConflictPolicy(
                            event.target.value as RollbackConflictPolicy
                          )
                        }
                      >
                        <option value="abort">中止回滚并报告冲突（推荐）</option>
                        <option value="skip">跳过冲突文档继续回滚</option>
                      </select>
                    </div>
                  </>
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

                {mode !== 'import' && mode !== 'restore' ? (
                  <div className="field">
                    <label htmlFor="elasticsearch-query">
                      查询 (ES Query DSL)
                      <span className="hint">留空 = match_all；size/sort 会被覆盖</span>
                    </label>
                    <textarea
                      id="elasticsearch-query"
                      className="code-textarea"
                      rows={5}
                      placeholder={`{\n  "range": { "ts": { "gte": "now-7d" } }\n}`}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </div>
                ) : null}

                {mode === 'export' ? (
                  <div className="field">
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={exportMapping}
                        onChange={(event) => setExportMapping(event.target.checked)}
                      />
                      <span>
                        同时导出索引 mapping/settings 到{' '}
                        <code>{`{outputFile}.mapping.json`}</code>
                      </span>
                    </label>
                  </div>
                ) : mode === 'import' ? (
                  <>
                    <div className="field">
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={createIndex}
                          onChange={(event) => setCreateIndex(event.target.checked)}
                        />
                        <span>目标索引不存在时自动创建（使用下方 mapping 来源）</span>
                      </label>
                      {!createIndex ? (
                        <span className="hint">
                          已关闭自动创建：目标索引必须已存在，下方 mapping 来源不生效。
                        </span>
                      ) : null}
                    </div>
                    <div className="field">
                      <label>Mapping 来源</label>
                      <div className="segmented">
                        <button
                          type="button"
                          className={
                            mappingSource === 'sidecar' ? 'segment segment-active' : 'segment'
                          }
                          onClick={() => setMappingSource('sidecar')}
                        >
                          旁车文件
                        </button>
                        <button
                          type="button"
                          className={
                            mappingSource === 'inline' ? 'segment segment-active' : 'segment'
                          }
                          onClick={() => setMappingSource('inline')}
                        >
                          自定义 JSON
                        </button>
                        <button
                          type="button"
                          className={
                            mappingSource === 'auto' ? 'segment segment-active' : 'segment'
                          }
                          onClick={() => setMappingSource('auto')}
                        >
                          自动（动态映射）
                        </button>
                      </div>
                      <span className="hint">
                        {mappingSource === 'sidecar'
                          ? detectedSidecar
                            ? `已检测到旁车：${detectedSidecar}`
                            : `未检测到旁车文件：${filePath}.mapping.json，导入会因缺少 mapping 失败，可改用「自动」或「自定义 JSON」`
                          : mappingSource === 'auto'
                            ? '不提供 mapping：目标索引不存在时由 Elasticsearch 按首个文档动态推断字段类型创建'
                            : '使用下方文本框中的 mapping JSON：可按导入数据生成、载入旁车映射或人工重定义 schema'}
                      </span>
                    </div>
                    {mappingSource === 'inline' ? (
                      <div className="field">
                        <label htmlFor="elasticsearch-inline-mapping">Mapping JSON</label>
                        <div className="field-row">
                          <button
                            type="button"
                            className="button button-secondary button-small"
                            disabled={!filePath.trim() || generatingSchema}
                            onClick={() => void handleGenerateMapping()}
                          >
                            {generatingSchema ? (
                              <Loader2 className="spin" size={14} />
                            ) : (
                              <FileJson size={14} />
                            )}
                            根据导入数据生成 Mapping
                          </button>
                          {detectedSidecar ? (
                            <button
                              type="button"
                              className="button button-secondary button-small"
                              onClick={() => void handleLoadSidecarMapping()}
                            >
                              <FolderOpen size={14} />
                              载入旁车 Mapping 并编辑
                            </button>
                          ) : null}
                        </div>
                        <textarea
                          id="elasticsearch-inline-mapping"
                          className="code-textarea"
                          rows={8}
                          placeholder={`{ "settings": { ... }, "mappings": { ... } }`}
                          value={inlineMapping}
                          onChange={(event) => setInlineMapping(event.target.value)}
                        />
                      </div>
                    ) : null}
                  </>
                ) : null}

                <div className="migration-action-row">
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={
                      running ||
                      !selectedConnection ||
                      (mode === 'direct' || mode === 'mirror'
                        ? !selectedIndex || !targetConnectionId
                        : mode === 'archive'
                          ? !selectedIndex || !hdfsConnectionId
                          : mode === 'restore'
                            ? !connectionId || !hdfsConnectionId
                          : !filePath ||
                            (mode === 'export'
                              ? !selectedIndex
                              : importTargetIndex.length === 0))
                    }
                    onClick={() => void handleStart()}
                  >
                    {running ? (
                      <Loader2 className="spin" size={16} />
                    ) : mode === 'export' ? (
                      <HardDriveDownload size={16} />
                    ) : mode === 'direct' ? (
                      <ArrowRightLeft size={16} />
                    ) : mode === 'mirror' || mode === 'archive' ? (
                      <Layers size={16} />
                    ) : mode === 'restore' ? (
                      <FolderOpen size={16} />
                    ) : (
                      <HardDriveUpload size={16} />
                    )}
                    {mode === 'direct'
                      ? '开始直连迁移'
                      : mode === 'mirror'
                        ? '开始镜像迁移'
                        : mode === 'archive'
                          ? '开始镜像存档'
                          : mode === 'restore'
                            ? '开始恢复存档'
                      : mode === 'export'
                        ? '开始导出'
                        : '开始导入'}
                  </button>
                  <span className="badge">
                    {mode === 'export' ? <FileJson size={13} /> : <ArrowRightLeft size={13} />}
                    {batchSize ? `每批 ${batchSize} 条` : '每批 500 条'}
                    {' / '}
                    {concurrency ? `并发 ${concurrency}` : '并发 1'}
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
                {result.mappingFile ? (
                  <div className="result-item">
                    <FileJson size={18} />
                    <div>
                      <strong title={result.mappingFile}>{shortPath(result.mappingFile)}</strong>
                      <span>Mapping 文件</span>
                    </div>
                  </div>
                ) : null}
                {mode === 'import' ? (
                  <div className="result-item">
                    <ArrowRightLeft size={18} />
                    <div>
                      <strong title={result.index}>{result.index}</strong>
                      <span>目标索引</span>
                    </div>
                  </div>
                ) : null}
                {result.indexCreated ? (
                  <div className="result-item">
                    <CheckCircle2 size={18} />
                    <div>
                      <strong>已创建</strong>
                      <span>目标索引</span>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {pendingDirect ? (
            <RiskConfirmDialog
              notice={directMigrationRiskNotice({
                sourceLabel: `${selectedConnection?.name ?? ''} / ${pendingDirect.index}`,
                targetLabel: `${
                  elasticsearchConnections.find(
                    (connection) => connection.id === pendingDirect.targetConnectionId
                  )?.name ?? ''
                } / ${pendingDirect.targetIndex}`,
                conflictPolicy: pendingDirect.conflictPolicy,
                rollbackOn: pendingDirect.rollbackOn
              })}
              confirmLabel="确认并开始迁移"
              busy={riskBusy}
              error={riskError}
              onCancel={() => {
                if (riskBusy) {
                  return
                }
                setPendingDirect(null)
                setRiskError(null)
              }}
              onConfirm={() => void confirmDirectRisk()}
            />
          ) : null}

          {pendingMirror ? (
            <RiskConfirmDialog
              notice={directMigrationRiskNotice({
                sourceLabel: `${selectedConnection?.name ?? ''} / ${pendingMirror.index}`,
                targetLabel: `${
                  elasticsearchConnections.find(
                    (connection) => connection.id === pendingMirror.targetConnectionId
                  )?.name ?? ''
                } / ${pendingMirror.index}`,
                conflictPolicy: pendingMirror.conflictPolicy,
                rollbackOn: pendingMirror.rollbackOn,
                dropCreatedTarget: pendingMirror.dropCreatedTarget
              })}
              confirmLabel="确认并开始镜像"
              busy={riskBusy}
              error={riskError}
              onCancel={() => {
                if (riskBusy) {
                  return
                }
                setPendingMirror(null)
                setRiskError(null)
              }}
              onConfirm={() => void confirmMirrorRisk()}
            />
          ) : null}

          {pendingArchive ? (
            <RiskConfirmDialog
              notice={mirrorArchiveRiskNotice({
                indexLabel: pendingArchive.index,
                hdfsLabel: `${
                  hdfsConnections.find(
                    (connection) => connection.id === pendingArchive.hdfsConnectionId
                  )?.name ?? ''
                }`,
                directory: pendingArchive.hdfsDirectory,
                existing: pendingArchive.existing ?? 'fail',
                cleanupOnFailure: pendingArchive.cleanupOnFailure !== false
              })}
              confirmLabel="确认并开始存档"
              busy={riskBusy}
              error={riskError}
              onCancel={() => {
                if (riskBusy) {
                  return
                }
                setPendingArchive(null)
                setRiskError(null)
              }}
              onConfirm={() => void confirmArchiveRisk()}
            />
          ) : null}

          {pendingRestore ? (
            <RiskConfirmDialog
              notice={directMigrationRiskNotice({
                sourceLabel: `HDFS ${
                  hdfsConnections.find(
                    (connection) => connection.id === pendingRestore.hdfsConnectionId
                  )?.name ?? ''
                }:${pendingRestore.hdfsDirectory}`,
                targetLabel: `${
                  elasticsearchConnections.find(
                    (connection) => connection.id === pendingRestore.targetConnectionId
                  )?.name ?? ''
                } / ${pendingRestore.targetIndex ?? '存档内索引名'}`,
                conflictPolicy: pendingRestore.conflictPolicy,
                rollbackOn: pendingRestore.rollbackOn,
                dropCreatedTarget: pendingRestore.dropCreatedTarget
              })}
              confirmLabel="确认并开始恢复"
              busy={riskBusy}
              error={riskError}
              onCancel={() => {
                if (riskBusy) {
                  return
                }
                setPendingRestore(null)
                setRiskError(null)
              }}
              onConfirm={() => void confirmRestoreRisk()}
            />
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

function shortPath(path: string, maxLength = 48): string {
  if (path.length <= maxLength) {
    return path
  }
  const tail = path.slice(path.length - (maxLength - 3))
  return `...${tail}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '迁移操作失败'
}

/** 当前风险文案版本的确认凭据；主进程会用同一版本再次校验。 */
function currentRiskAck(): RiskAck {
  return {
    version: RISK_NOTICE_VERSION,
    acknowledgedAt: new Date().toISOString(),
    acknowledgedBy: 'ui'
  }
}

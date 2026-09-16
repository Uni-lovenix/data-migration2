import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Check, FileJson, FolderOpen, Loader2, PlugZap, X } from 'lucide-react'

import type {
  ConnectionConfig,
  FieldTransform,
  MySQLConflictAction,
  MySQLConnectionTestResult,
  MySQLImportRequest,
  MySQLTableRef
} from '../../../shared/types'
import { validateMySQLImportRequest } from '../../../shared/validation'
import { ColumnSelection } from '../components/ColumnSelection'
import { FieldTransformsEditor } from '../components/FieldTransformsEditor'

interface MySQLImportTabProps {
  connections: ConnectionConfig[]
  onNavigate: (view: 'tasks') => void
}

type Status =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string }
  | { kind: 'success'; rows: number; durationMs: number }

const CONFLICT_OPTIONS: Array<{
  value: MySQLConflictAction
  label: string
  description: string
}> = [
  { value: 'error', label: 'error', description: '冲突立即报错（默认）' },
  { value: 'skip', label: 'skip', description: '静默跳过冲突行（INSERT IGNORE）' },
  {
    value: 'update',
    label: 'update',
    description: '覆盖冲突行（ON DUPLICATE KEY UPDATE）'
  }
]

/**
 * MySQL 导入 tab。基于 PM Design §3 UI demo 落地：与导出 tab 镜像对称，
 * 表名改为文本框（导入目标表不能从源库拉），冲突策略三态（error / skip / update）。
 */
export function MySQLImportTab({
  connections,
  onNavigate
}: MySQLImportTabProps): ReactElement {
  const mysqlConnections = connections.filter((c) => c.type === 'mysql')

  const [connectionId, setConnectionId] = useState('')
  const [database, setDatabase] = useState('')
  const [tableName, setTableName] = useState('')
  const [inputFile, setInputFile] = useState('')
  const [onConflict, setOnConflict] = useState<MySQLConflictAction>('error')
  const [batchSize, setBatchSize] = useState('500')
  const [selectedColumns, setSelectedColumns] = useState<string[]>([])
  const [fieldTransforms, setFieldTransforms] = useState<FieldTransform[]>([])
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [testResult, setTestResult] = useState<MySQLConnectionTestResult | null>(null)
  const [testing, setTesting] = useState(false)

  const selectedConnection =
    mysqlConnections.find((c) => c.id === connectionId) ?? null

  // 连接变更时同步默认 database 并清空测试结果
  useEffect(() => {
    setDatabase(selectedConnection?.database ?? '')
    setTestResult(null)
    setSelectedColumns([])
    setFieldTransforms([])
  }, [connectionId, selectedConnection])

  async function handlePickFile(): Promise<void> {
    try {
      const file = await window.api.dialog.chooseImportFile()
      if (file) {
        setInputFile(file)
        setSelectedColumns([])
        setFieldTransforms([])
        setStatus({ kind: 'idle' })
      }
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : '选择文件失败'
      })
    }
  }

  async function handleTest(): Promise<void> {
    if (!connectionId) {
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.api.mysql.test(connectionId, database || undefined)
      setTestResult(result)
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : '测试失败'
      })
    } finally {
      setTesting(false)
    }
  }

  async function handleSubmit(): Promise<void> {
    if (!connectionId || !tableName.trim() || !inputFile.trim()) {
      setStatus({
        kind: 'error',
        message: '请填写完整：连接 / 目标表 / 输入文件'
      })
      return
    }
    const parsedBatchSize = Number(batchSize)
    const table: MySQLTableRef = { schema: database, name: tableName.trim() }
    const request: MySQLImportRequest = {
      connectionId,
      table,
      inputFile: inputFile.trim(),
      batchSize: parsedBatchSize,
      onConflict,
      ...(database ? { database } : {}),
      ...(selectedColumns.length > 0 ? { selectedColumns } : {}),
      ...(fieldTransforms.length > 0 ? { fieldTransforms } : {})
    }
    const validation = validateMySQLImportRequest(request)
    if (!validation.ok) {
      setStatus({
        kind: 'error',
        message: validation.errors.join('；')
      })
      return
    }

    setStatus({ kind: 'submitting' })
    try {
      await window.api.tasks.create({
        type: 'mysql-import',
        payload: validation.value
      })
      setStatus({
        kind: 'success',
        rows: 0,
        durationMs: 0
      })
      // 提交成功，跳到任务列表看进度
      onNavigate('tasks')
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : '导入任务创建失败'
      })
    }
  }

  if (mysqlConnections.length === 0) {
    return (
      <div className="mysql-import-tab">
        <div className="empty-state">
          <FileJson size={30} />
          <span>还没有 MySQL 连接</span>
          <p>请先在「连接管理」中创建 MySQL 连接</p>
        </div>
      </div>
    )
  }

  const submitting = status.kind === 'submitting'
  const canStart =
    !submitting &&
    Boolean(connectionId) &&
    Boolean(tableName.trim()) &&
    Boolean(inputFile.trim())

  return (
    <div className="mysql-import-tab">
      {/* 连接 + 测试 */}
      <section className="form-row">
        <label htmlFor="mysql-import-connection">连接</label>
        <select
          id="mysql-import-connection"
          value={connectionId}
          onChange={(e) => {
            setConnectionId(e.target.value)
            setTestResult(null)
          }}
          disabled={submitting}
        >
          <option value="">选择连接</option>
          {mysqlConnections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}（{c.host}:{c.port}）
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button button-secondary"
          disabled={!connectionId || testing || submitting}
          onClick={() => void handleTest()}
        >
          {testing ? <Loader2 className="spin" size={14} /> : <PlugZap size={14} />}
          测试连接
        </button>
        {testResult ? (
          <span
            className={`badge ${testResult.ok ? 'badge-ok' : 'badge-error'}`}
            title={testResult.message}
          >
            {testResult.ok ? (
              <>
                <Check size={12} /> 已连接 {testResult.serverVersion ?? ''}
              </>
            ) : (
              <>
                <X size={12} /> {testResult.message ?? '连接失败'}
              </>
            )}
          </span>
        ) : null}
      </section>

      {/* 数据库 + 目标表 */}
      <section className="form-row">
        <label htmlFor="mysql-import-database">数据库</label>
        <input
          id="mysql-import-database"
          type="text"
          value={database}
          onChange={(e) => {
            setDatabase(e.target.value)
            setSelectedColumns([])
            setFieldTransforms([])
          }}
          placeholder="（留空使用连接默认 database）"
          disabled={submitting}
        />
        <label htmlFor="mysql-import-table">目标表</label>
        <input
          id="mysql-import-table"
          type="text"
          value={tableName}
          onChange={(e) => {
            setTableName(e.target.value)
            setSelectedColumns([])
            setFieldTransforms([])
          }}
          placeholder="例如：orders"
          disabled={submitting}
        />
      </section>

      {/* 输入文件 */}
      <section className="form-row">
        <label htmlFor="mysql-import-file">JSONL 文件</label>
        <input
          id="mysql-import-file"
          type="text"
          value={inputFile}
          onChange={(e) => setInputFile(e.target.value)}
          placeholder="选择或粘贴 JSONL 文件绝对路径"
          disabled={submitting}
        />
        <button
          type="button"
          className="button button-secondary"
          disabled={submitting}
          onClick={() => void handlePickFile()}
        >
          <FolderOpen size={14} />
          选择文件…
        </button>
      </section>

      <ColumnSelection
        inputFile={inputFile}
        selectedColumns={selectedColumns}
        onChange={setSelectedColumns}
      />
      <FieldTransformsEditor
        inputFile={inputFile}
        transforms={fieldTransforms}
        onChange={setFieldTransforms}
      />

      {/* 冲突策略 + batch-size */}
      <section className="form-row">
        <label htmlFor="mysql-import-conflict">冲突策略</label>
        <select
          id="mysql-import-conflict"
          value={onConflict}
          onChange={(e) =>
            setOnConflict(e.target.value as MySQLConflictAction)
          }
          disabled={submitting}
        >
          {CONFLICT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label} — {opt.description}
            </option>
          ))}
        </select>
        <label htmlFor="mysql-import-batch-size">批量大小</label>
        <input
          id="mysql-import-batch-size"
          type="number"
          min={1}
          max={10000}
          value={batchSize}
          onChange={(e) => setBatchSize(e.target.value)}
          disabled={submitting}
        />
      </section>

      {/* 状态横幅 */}
      {status.kind === 'error' ? (
        <div className="inline-error" role="alert">
          ⚠ {status.message}
        </div>
      ) : null}
      {status.kind === 'submitting' ? (
        <div className="status-banner submitting">
          任务已加入队列，可在「任务列表」查看进度并取消。
        </div>
      ) : null}

      {/* 提交 */}
      <section className="form-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!canStart}
          onClick={() => void handleSubmit()}
        >
          {submitting ? (
            <Loader2 className="spin" size={16} />
          ) : (
            <FileJson size={16} />
          )}
          {submitting ? '提交中…' : '开始导入'}
        </button>
        <span className="badge">
          {batchSize ? `每批 ${batchSize} 行` : '每批 500 行'}
        </span>
      </section>

      {/* 帮助 */}
      <details className="help">
        <summary>JSONL 信封格式说明</summary>
        <p>输入文件可以是 PG / ES / MySQL 导出的标准 JSONL：</p>
        <pre>{`{"table":{"schema":"public","name":"orders"},"columns":["id","name"],"rows":[[1,"alice"],[2,"bob"]]}`}</pre>
        <p>或逐行记录（PG / ES 导出器的行长）：</p>
        <pre>{`{"id":1,"name":"alice"}
{"id":2,"name":"bob"}`}</pre>
        <p>
          目标表必须预先创建（DDL 不在本工具范围内）。缺失列时会在导入第一行时报错并列出具体列名。
        </p>
      </details>
    </div>
  )
}

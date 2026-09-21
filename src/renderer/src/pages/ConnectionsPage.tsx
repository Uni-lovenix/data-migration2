import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { Database, Pencil, Plus, Search, Trash2 } from 'lucide-react'

import type {
  ConnectionConfig,
  ConnectionInput,
  ConnectionType
} from '../../../shared/types'
import { connectionTypeLabel } from '../../../shared/validation'
import { ConnectionModal } from '../components/ConnectionModal'
import { IconButton } from '../components/IconButton'

interface ConnectionsPageProps {
  connections: ConnectionConfig[]
  isLoading: boolean
  error: string | null
  onCreate: (input: ConnectionInput) => Promise<ConnectionConfig>
  onUpdate: (id: string, input: ConnectionInput) => Promise<ConnectionConfig>
  onDelete: (id: string) => Promise<void>
}

type Filter = 'all' | ConnectionType

interface ModalState {
  mode: 'create' | 'edit'
  connection?: ConnectionConfig
  initialType?: ConnectionType
}

export function ConnectionsPage({
  connections,
  isLoading,
  error,
  onCreate,
  onUpdate,
  onDelete
}: ConnectionsPageProps): ReactElement {
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState<ModalState | null>(null)

  const filteredConnections = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return connections.filter((connection) => {
      if (filter !== 'all' && connection.type !== filter) {
        return false
      }
      if (keyword.length === 0) {
        return true
      }
      return (
        connection.name.toLowerCase().includes(keyword) ||
        connection.host.toLowerCase().includes(keyword) ||
        (connection.database ?? connection.defaultIndex ?? '').toLowerCase().includes(keyword)
      )
    })
  }, [connections, filter, search])

  async function handleDelete(connection: ConnectionConfig): Promise<void> {
    const confirmed = window.confirm(`删除连接「${connection.name}」？`)
    if (!confirmed) {
      return
    }
    try {
      await onDelete(connection.id)
    } catch {
      // Error is surfaced by the shared connection store when invoked.
    }
  }

  function openCreateModal(): void {
    setModal({
      mode: 'create',
      initialType: filter === 'all' ? undefined : filter
    })
  }

  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>连接</h1>
          <p>管理 PostgreSQL、Elasticsearch、MySQL、SQLite、Hive、Access 与 Neo4j 数据源</p>
        </div>
        <button
          type="button"
          className="button button-primary"
          onClick={openCreateModal}
        >
          <Plus size={16} />
          新建连接
        </button>
      </div>

      <div className="toolbar">
        <div className="segmented">
          <button
            type="button"
            className={filter === 'all' ? 'segment segment-active' : 'segment'}
            onClick={() => setFilter('all')}
          >
            全部
          </button>
          <button
            type="button"
            className={filter === 'postgresql' ? 'segment segment-active' : 'segment'}
            onClick={() => setFilter('postgresql')}
          >
            PostgreSQL
          </button>
          <button
            type="button"
            className={filter === 'elasticsearch' ? 'segment segment-active' : 'segment'}
            onClick={() => setFilter('elasticsearch')}
          >
            Elasticsearch
          </button>
          <button
            type="button"
            className={filter === 'mysql' ? 'segment segment-active' : 'segment'}
            onClick={() => setFilter('mysql')}
          >
            MySQL
          </button>
          <button
            type="button"
            className={filter === 'sqlite' ? 'segment segment-active' : 'segment'}
            onClick={() => setFilter('sqlite')}
          >
            SQLite
          </button>
          <button
            type="button"
            className={filter === 'hive' ? 'segment segment-active' : 'segment'}
            onClick={() => setFilter('hive')}
          >
            Hive
          </button>
          <button
            type="button"
            className={filter === 'neo4j' ? 'segment segment-active' : 'segment'}
            onClick={() => setFilter('neo4j')}
          >
            Neo4j
          </button>
          <button
            type="button"
            className={filter === 'access' ? 'segment segment-active' : 'segment'}
            onClick={() => setFilter('access')}
          >
            Access
          </button>
        </div>

        <div className="search-box">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索名称、主机或数据库"
            aria-label="搜索连接"
          />
        </div>
      </div>

      {error ? <div className="inline-error">{error}</div> : null}

      <div className="table-card">
        {isLoading ? (
          <div className="table-empty">加载中…</div>
        ) : filteredConnections.length === 0 ? (
          <div className="table-empty">
            <Database size={30} />
            <span>没有匹配的连接</span>
            <button
              type="button"
              className="button button-primary"
              onClick={openCreateModal}
            >
              <Plus size={15} />
              新建连接
            </button>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>地址</th>
                <th>数据库 / 索引</th>
                <th>SSL</th>
                <th>更新时间</th>
                <th className="actions-column">操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredConnections.map((connection) => (
                <tr key={connection.id}>
                  <td>
                    <div className="cell-name">{connection.name}</div>
                    {connection.username ? (
                      <div className="cell-sub">{connection.username}</div>
                    ) : null}
                  </td>
                  <td>
                    <span className="badge">{connectionTypeLabel(connection.type)}</span>
                  </td>
                  <td>
                    <code>
                      {connection.type === 'sqlite' || connection.type === 'access'
                        ? connection.filePath ?? connection.host
                        : `${connection.host}:${connection.port}`}
                    </code>
                  </td>
                  <td>
                    {connection.type === 'sqlite' || connection.type === 'access'
                      ? '本地文件'
                      : connection.database ?? connection.defaultIndex ?? '—'}
                  </td>
                  <td>
                    <span className={connection.ssl ? 'state-on' : 'state-off'}>
                      {connection.type === 'sqlite' || connection.type === 'access'
                        ? '不适用'
                        : connection.ssl
                          ? '开启'
                          : '关闭'}
                    </span>
                  </td>
                  <td className="cell-muted">
                    {formatDateTime(connection.updatedAt)}
                  </td>
                  <td className="actions-column">
                    <IconButton
                      icon={Pencil}
                      label="编辑"
                      onClick={() => setModal({ mode: 'edit', connection })}
                    />
                    <IconButton
                      icon={Trash2}
                      label="删除"
                      variant="danger"
                      onClick={() => void handleDelete(connection)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modal ? (
        <ConnectionModal
          mode={modal.mode}
          connection={modal.connection}
          initialType={modal.initialType}
          onClose={() => setModal(null)}
          onSave={async (input) => {
            if (modal.mode === 'create') {
              await onCreate(input)
            } else if (modal.connection) {
              await onUpdate(modal.connection.id, input)
            }
          }}
        />
      ) : null}
    </div>
  )
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

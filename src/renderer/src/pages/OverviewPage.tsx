import {
  ArrowRight,
  Database,
  HardDrive,
  Plus,
  SearchCheck,
  Server
} from 'lucide-react'
import type { ReactElement } from 'react'

import type { ConnectionConfig, ViewKey } from '../../../shared/types'
import { connectionTypeLabel } from '../../../shared/validation'

interface OverviewPageProps {
  connections: ConnectionConfig[]
  onNavigate: (view: ViewKey) => void
}

interface Metric {
  label: string
  value: number
  icon: typeof Database
}

export function OverviewPage({
  connections,
  onNavigate
}: OverviewPageProps): ReactElement {
  const postgresCount = connections.filter(
    (connection) => connection.type === 'postgresql'
  ).length
  const elasticsearchCount = connections.filter(
    (connection) => connection.type === 'elasticsearch'
  ).length
  const recentConnections = [...connections]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 5)

  const metrics: Metric[] = [
    { label: '连接总数', value: connections.length, icon: Server },
    { label: 'PostgreSQL', value: postgresCount, icon: Database },
    { label: 'Elasticsearch', value: elasticsearchCount, icon: SearchCheck },
    { label: '本地状态', value: 1, icon: HardDrive }
  ]

  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>总览</h1>
          <p>数据连接与迁移工作区</p>
        </div>
        <button
          type="button"
          className="button button-primary"
          onClick={() => onNavigate('connections')}
        >
          <Plus size={16} />
          管理连接
        </button>
      </div>

      <div className="metric-grid">
        {metrics.map((metric) => {
          const Icon = metric.icon
          return (
            <div className="metric-card" key={metric.label}>
              <span className="metric-icon">
                <Icon size={18} />
              </span>
              <div>
                <div className="metric-value">{metric.value}</div>
                <div className="metric-label">{metric.label}</div>
              </div>
            </div>
          )
        })}
      </div>

      <section className="section">
        <div className="section-heading">
          <h2>最近连接</h2>
          <button type="button" className="text-button" onClick={() => onNavigate('connections')}>
            查看全部
            <ArrowRight size={14} />
          </button>
        </div>

        {recentConnections.length === 0 ? (
          <div className="empty-state">
            <Database size={28} />
            <span>还没有连接配置</span>
          </div>
        ) : (
          <div className="recent-list">
            {recentConnections.map((connection) => (
              <div className="recent-row" key={connection.id}>
                <span className={`type-dot type-dot-${connection.type}`} />
                <div className="recent-main">
                  <strong>{connection.name}</strong>
                  <span>{`${connection.host}:${connection.port}`}</span>
                </div>
                <span className="badge">{connectionTypeLabel(connection.type)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

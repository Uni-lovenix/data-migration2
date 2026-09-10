import {
  ArrowRightLeft,
  Brain,
  Database,
  GitBranch,
  LayoutDashboard,
  ListChecks,
  Workflow
} from 'lucide-react'
import type { ReactElement } from 'react'

import type { ViewKey } from '../../../shared/types'

interface SidebarProps {
  activeView: ViewKey
  version: string
  onNavigate: (view: ViewKey) => void
}

const navItems: Array<{ key: ViewKey; label: string; icon: typeof Database }> = [
  { key: 'overview', label: '总览', icon: LayoutDashboard },
  { key: 'connections', label: '连接', icon: Database },
  { key: 'migration', label: '迁移', icon: ArrowRightLeft },
  { key: 'tasks', label: '任务', icon: ListChecks },
  { key: 'templates', label: '迁移模板', icon: GitBranch },
  { key: 'llm', label: 'LLM', icon: Brain }
]

export function Sidebar({ activeView, version, onNavigate }: SidebarProps): ReactElement {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-logo">
          <Workflow size={20} strokeWidth={2.2} />
        </span>
        <div>
          <div className="sidebar-title">DataMigrator</div>
          <div className="sidebar-subtitle">数据迁移工作台</div>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="主导航">
        {navItems.map((item) => {
          const Icon = item.icon
          const active = activeView === item.key
          return (
            <button
              key={item.key}
              type="button"
              className={active ? 'nav-item nav-item-active' : 'nav-item'}
              onClick={() => onNavigate(item.key)}
            >
              <Icon size={17} />
              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-version">v{version}</div>
      </div>
    </aside>
  )
}

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import type { AppInfo, ViewKey } from '../../shared/types'
import { Sidebar } from './components/Sidebar'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useConnections } from './hooks/useConnections'
import { useLLM } from './hooks/useLLM'
import { ConnectionsPage } from './pages/ConnectionsPage'
import { MigrationPage } from './pages/MigrationPage'
import { LLMSettings } from './pages/LLMSettings'
import { OverviewPage } from './pages/OverviewPage'
import { TasksPage } from './pages/TasksPage'
import { TemplatesPage } from './pages/TemplatesPage'
import { AgentPage } from './pages/AgentPage'
import { TokenInPage } from './pages/TokenInPage'

interface TopbarContext {
  breadcrumb: string
  title: string
}

const TOPBAR_MAP: Record<ViewKey, TopbarContext> = {
  overview: { breadcrumb: '工作区', title: '总览' },
  connections: { breadcrumb: '数据源', title: '连接' },
  tasks: { breadcrumb: '后台任务', title: '任务' },
  llm: { breadcrumb: '智能体', title: 'LLM 配置' },
  agent: { breadcrumb: '智能体', title: '智能体对话' },
  'token-in': { breadcrumb: '智能体', title: 'Token-In' },
  templates: { breadcrumb: '迁移', title: '迁移模板' },
  migration: { breadcrumb: '迁移', title: '数据迁移' }
}

export function App(): ReactElement {
  const [activeView, setActiveView] = useState<ViewKey>('overview')
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const connectionsApi = useConnections()
  const llmApi = useLLM()

  useEffect(() => {
    window.api.app
      .getInfo()
      .then(setAppInfo)
      .catch(() => {
        // The app can still run when app metadata is unavailable.
      })
  }, [])

  const topbar = TOPBAR_MAP[activeView]

  return (
    <div className="app-shell">
      <Sidebar
        activeView={activeView}
        version={appInfo?.version ?? '0.0.0'}
        onNavigate={setActiveView}
      />
      <main className="main">
        <header className="topbar">
          <div>
            <span className="topbar-context">{topbar.breadcrumb}</span>
            <strong>{topbar.title}</strong>
          </div>
          <span className="topbar-platform">
            {appInfo ? `${appInfo.platform} · ${appInfo.arch}` : ''}
          </span>
        </header>

        <div className="content">
          <ErrorBoundary>
            {activeView === 'overview' ? (
              <OverviewPage
                connections={connectionsApi.connections}
                onNavigate={setActiveView}
              />
            ) : activeView === 'connections' ? (
              <ConnectionsPage
                connections={connectionsApi.connections}
                isLoading={connectionsApi.isLoading}
                error={connectionsApi.error}
                onCreate={async (input) => {
                  const created = await connectionsApi.create(input)
                  return created
                }}
                onUpdate={connectionsApi.update}
                onDelete={connectionsApi.remove}
              />
            ) : activeView === 'tasks' ? (
              <TasksPage
                connections={connectionsApi.connections}
                onNavigate={setActiveView}
              />
            ) : activeView === 'llm' ? (
              <LLMSettings
                configs={llmApi.configs}
                isLoading={llmApi.isLoading}
                error={llmApi.error}
                onCreate={llmApi.create}
                onUpdate={llmApi.update}
                onDelete={llmApi.remove}
                onToggle={llmApi.toggle}
              />
            ) : activeView === 'agent' ? (
              <AgentPage />
            ) : activeView === 'token-in' ? (
              <TokenInPage />
            ) : activeView === 'templates' ? (
              <TemplatesPage connections={connectionsApi.connections} />
            ) : (
              <MigrationPage
                connections={connectionsApi.connections}
                onNavigate={setActiveView}
              />
            )}
          </ErrorBoundary>
        </div>
      </main>
    </div>
  )
}

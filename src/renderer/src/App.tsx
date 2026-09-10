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
            <span className="topbar-context">
              {activeView === 'overview'
                ? '工作区'
                : activeView === 'connections'
                  ? '数据源'
                  : activeView === 'tasks'
                    ? '后台任务'
                    : activeView === 'llm'
                      ? '智能体'
                      : activeView === 'templates'
                        ? '模板'
                        : '迁移'}
            </span>
            <strong>
              {activeView === 'overview'
                ? '总览'
                : activeView === 'connections'
                  ? '连接'
                  : activeView === 'tasks'
                    ? '任务'
                    : activeView === 'llm'
                      ? 'LLM 配置'
                      : activeView === 'templates'
                        ? '模板'
                        : '数据迁移'}
            </strong>
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
              <TasksPage />
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
            ) : activeView === 'templates' ? (
              <TemplatesPage />
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

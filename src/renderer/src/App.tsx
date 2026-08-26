import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import type { AppInfo, ViewKey } from '../../shared/types'
import { Sidebar } from './components/Sidebar'
import { useConnections } from './hooks/useConnections'
import { ConnectionsPage } from './pages/ConnectionsPage'
import { MigrationPage } from './pages/MigrationPage'
import { OverviewPage } from './pages/OverviewPage'

export function App(): ReactElement {
  const [activeView, setActiveView] = useState<ViewKey>('overview')
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const connectionsApi = useConnections()

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
                  : '迁移'}
            </span>
            <strong>
              {activeView === 'overview'
                ? '总览'
                : activeView === 'connections'
                  ? '连接'
                  : '数据迁移'}
            </strong>
          </div>
          <span className="topbar-platform">
            {appInfo ? `${appInfo.platform} · ${appInfo.arch}` : ''}
          </span>
        </header>

        <div className="content">
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
          ) : (
            <MigrationPage
              connections={connectionsApi.connections}
              onNavigate={setActiveView}
            />
          )}
        </div>
      </main>
    </div>
  )
}

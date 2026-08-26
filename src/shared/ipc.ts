export const IPC_CHANNELS = {
  app: {
    getInfo: 'app:get-info'
  },
  connections: {
    list: 'connections:list',
    create: 'connections:create',
    update: 'connections:update',
    delete: 'connections:delete'
  },
  postgres: {
    test: 'postgres:test',
    tables: 'postgres:tables',
    export: 'postgres:export',
    import: 'postgres:import'
  },
  elasticsearch: {
    test: 'elasticsearch:test',
    indices: 'elasticsearch:indices',
    export: 'elasticsearch:export',
    import: 'elasticsearch:import'
  },
  dialog: {
    chooseExportFile: 'dialog:choose-export-file',
    chooseImportFile: 'dialog:choose-import-file'
  }
} as const

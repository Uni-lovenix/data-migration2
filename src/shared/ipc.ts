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
    databases: 'postgres:databases',
    tables: 'postgres:tables',
    countRows: 'postgres:count-rows',
    export: 'postgres:export',
    exportTables: 'postgres:export-tables',
    import: 'postgres:import'
  },
  elasticsearch: {
    test: 'elasticsearch:test',
    indices: 'elasticsearch:indices',
    export: 'elasticsearch:export',
    import: 'elasticsearch:import'
  },
  mysql: {
    test: 'mysql:test',
    databases: 'mysql:databases',
    tables: 'mysql:tables',
    countRows: 'mysql:count-rows',
    export: 'mysql:export',
    exportTables: 'mysql:export-tables'
  },
  sqlite: {
    test: 'sqlite:test',
    tables: 'sqlite:tables',
    countRows: 'sqlite:count-rows',
    export: 'sqlite:export',
    exportTables: 'sqlite:export-tables'
  },
  access: {
    test: 'access:test',
    tables: 'access:tables',
    countRows: 'access:count-rows',
    export: 'access:export',
    exportTables: 'access:export-tables'
  },
  hive: {
    test: 'hive:test',
    databases: 'hive:databases',
    tables: 'hive:tables',
    countRows: 'hive:count-rows',
    export: 'hive:export',
    exportTables: 'hive:export-tables'
  },
  neo4j: {
    test: 'neo4j:test',
    tables: 'neo4j:tables',
    countNodes: 'neo4j:count-nodes',
    countRelationships: 'neo4j:count-relationships',
    export: 'neo4j:export',
    exportTables: 'neo4j:export-tables'
  },
  tasks: {
    list: 'tasks:list',
    create: 'tasks:create',
    cancel: 'tasks:cancel',
    resume: 'tasks:resume',
    changed: 'tasks:changed'
  },
  templates: {
    list: 'templates:list',
    get: 'templates:get',
    create: 'templates:create',
    update: 'templates:update',
    delete: 'templates:delete',
    execute: 'templates:execute',
    executeMany: 'templates:execute-many'
  },
  dialog: {
    chooseExportFile: 'dialog:choose-export-file',
    chooseExportDirectory: 'dialog:choose-export-directory',
    chooseImportFile: 'dialog:choose-import-file',
    chooseSqliteFile: 'dialog:choose-sqlite-file',
    chooseAccessFile: 'dialog:choose-access-file'
  },
  llm: {
    list: 'llm:list',
    get: 'llm:get',
    create: 'llm:create',
    update: 'llm:update',
    delete: 'llm:delete',
    chat: 'llm:chat'
  },
  agent: {
    listSessions: 'agent:list-sessions',
    getSession: 'agent:get-session',
    createSession: 'agent:create-session',
    renameSession: 'agent:rename-session',
    deleteSession: 'agent:delete-session',
    listMessages: 'agent:list-messages',
    chat: 'agent:chat',
    setLlmConfig: 'agent:set-llm-config'
  },
  apiTokens: {
    list: 'api-tokens:list',
    create: 'api-tokens:create',
    revoke: 'api-tokens:revoke',
    apiBase: 'api-tokens:api-base'
  },
  restApi: {
    call: 'rest-api:call'
  },
  fs: {
    exists: 'fs:exists'
  }
} as const

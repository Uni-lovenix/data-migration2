# Iteration 024 -- 导入自定义目标与 schema 初始化（Elasticsearch）

## 目标

让 Elasticsearch 导入支持写入自定义名称的目标索引；当目标索引不存在时，按 mapping 来源（旁车文件 / 人工重定义的内联 schema / 自动动态映射）先初始化索引，再写入数据。

## 范围

- 导入模式新增「目标索引名称」输入框，可填写当前不存在的索引名。
- 目标索引不存在时按 `mapping.source` 初始化：`sidecar` / `inline` / `auto`。
- 自定义 JSON 模式支持「载入旁车 Mapping 并编辑」，实现人工重定义 schema 后再创建导入。
- 关闭「目标索引不存在时自动创建」时保持既有语义（目标必须已存在）。
- SQL 目标端（PostgreSQL / MySQL / SQLite / Hive）的目标表自动建表不在本次范围。

## 实现

- `src/shared/types.ts`：`ElasticsearchMappingSource` 增加 `'auto'`；补齐 `index` / `createIndex` / `mapping` 语义注释（省略 `mapping` 等价于 `auto`）。
- `src/shared/validation.ts`：`validateMappingConfig` 接受 `'auto'` 并忽略 `inlineJson` / `sidecarPath`。
- `src/main/go-elasticsearch-service.ts`：`buildImportArgs` 按 `sidecar` / `inline` / `auto` 分支传参；`auto` 不传 mapping 标志。
- `golang/esmigrator/import.go`：`ensureIndex` 在未提供 mapping 时以空 body `{}` PUT 创建索引（动态映射），返回 `indexCreated=true` / `mappingSource=auto`；显式 mapping 内容为空仍报错。
- `src/main/index.ts` + `src/preload/*` + `src/shared/ipc.ts`：新增 `fs.readText`（≤5 MB）供渲染层载入旁车 mapping 编辑。
- `src/renderer/src/pages/ElasticsearchMigrationPanel.tsx`：
  - 新增 `targetIndex` 状态与「目标索引名称」输入；选连接清空、选索引/加载索引回填。
  - 依据已加载索引判断目标是否存在，给出「已存在，直接写入」/「不存在，将按 mapping 来源创建」提示。
  - Mapping 来源三段式：旁车文件 / 自定义 JSON / 自动（动态映射）；自定义 JSON 支持一键载入旁车 mapping。
  - 导入按钮在导入模式改为要求目标索引名非空（不再要求目标已存在）。

## 验收结果

| # | 标准 | 结果 |
|---|---|---|
| 1 | 导入可自定义目标索引名称（含不存在的名称） | PASS |
| 2 | 目标不存在时按旁车 / 内联 / 自动三种来源初始化 | PASS |
| 3 | 可载入旁车 mapping 并人工重定义后再创建导入 | PASS |
| 4 | 关闭自动创建时目标必须已存在，mapping 来源不生效 | PASS |
| 5 | 引擎无 mapping 时以空 body 动态建索引 | PASS |

## 验证证据

| 检查 | 命令 / 方式 | 结果 | 备注 |
|---|---|---|---|
| 类型检查 | `npm run typecheck` | 通过 | node + web |
| JS 测试 | `npm test` | 通过 | 272 passed / 15 skipped |
| Go 测试 | `npm run test:go` | 通过 | 含新增动态建索引用例 |
| Go 静态检查 | `npm run vet:go` | 通过 | esmigrator + accessmigrator |
| 生产构建 | `npm run build` | 通过 | out/main、out/preload、out/renderer |
| 原生引擎动态建索引 | esmigrator import（9202） | 通过 | `indexCreated=true`、`mappingSource=auto`、字段动态映射 |
| 原生引擎内联 schema | esmigrator import --inline-mapping | 通过 | 目标字段按自定义 mapping 创建为 keyword |
| 应用闭环 | window.api.tasks.create（auto / inline） | 通过 | 两条路径任务 completed，索引按预期创建并写入 |
| 界面 | Electron CDP | 通过 | 目标索引输入、存在性提示、mapping 来源三态切换正常 |

## 风险 / 备注

- `auto` 依赖 Elasticsearch 动态映射；如需强制字段类型，应使用旁车或自定义 JSON。
- 动态 mapping 字段类型由首个写入文档推断，源数据同字段类型不一致时可能产生 mapping 冲突，日志会给出 bulk 错误。

# Iteration 029 -- HDFS 存档恢复闭环与移交验收

状态：**已实现并通过真实实例验证；移交验收完成**

阶段：construction -> transition（移交）

---

## 1. 目标

1. 补上 HDFS 镜像存档的闭环：**从 HDFS 恢复到目标集群**（`elasticsearch-mirror-restore`）。
2. 完成 RUP 移交阶段的最终验收：复跑全部检查、完成打包、整理交付说明与已知问题。

## 2. HDFS 存档恢复设计

```text
<hdfsDirectory>/manifest.json (status=complete)
        |
        |  1. 读取 manifest + metadata.json（拒绝 incomplete / 版本不符）
        |  2. 目标索引不存在时按 metadata 创建（settings/mappings，可选别名）
        |  3. 逐分片流式读取 data/part-*.jsonl
        |     - 边读边算 md5 与行数，与 manifest 校验（verifyChecksums）
        |     - 按 batchSize 攒批，交给直连写入链路（含撤销日志）
        v
目标集群索引（默认与存档同名，可用 targetIndex 覆盖）
```

- 复用 iteration-027/028 的写入与撤销日志：恢复任务失败/取消同样按 `rollbackOn` 自动回滚，`dropCreatedTarget` 为真时回滚连带删除本次创建的目标索引。
- 分片读取是流式的（WebHDFS `OPEN` 重定向 + 读流），避免大存档整文件进内存。
- 校验开关 `verifyChecksums`（默认开）：任何分片 md5 或行数不一致立即失败，避免"看起来成功、实际缺数据"。
- 恢复任务的 payload 没有源 ES 连接（数据来自 HDFS），任务调度时以目标集群连接作为任务连接占位（e2e 测试发现并修复的真实缺陷）。

## 3. 验收结果（本轮）

| # | 标准 | 结果 |
|---|---|---|
| 1 | HDFS 存档恢复到目标索引（闭环） | PASS（40 篇存档 → 恢复到新索引 40 篇 + mapping 一致 + 文档内容一致） |
| 2 | 恢复后整体回滚 | PASS（删除 40 篇并删除本次创建的目标索引，目标 404） |
| 3 | 拒绝恢复 incomplete 存档 | PASS（`存档不完整（status=incomplete）`） |
| 4 | 分片篡改可被检出 | PASS（`存档分片校验失败：... md5 不一致`） |
| 5 | 应用内闭环 | PASS（Electron：存档 40 → 恢复 40 → 回滚删索引 404） |
| 6 | 恢复任务风险确认 | PASS（表单 + 风险对话框渲染，riskAck 缺失被拒绝） |

## 4. 移交验收记录

### 4.1 最终复跑（2026-09-29）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | PASS（node + web） |
| 单元/组件测试 | `npm test` | PASS：26 文件，313 passed / 39 skipped |
| PostgreSQL 集成 | `POSTGRES_INTEGRATION=1 ... tests/postgres*.integration.test.ts` | PASS |
| Elasticsearch 集成 | `ELASTICSEARCH_INTEGRATION=1 ... tests/elasticsearch*.integration.test.ts` | PASS |
| 跨集群镜像 | `ELASTICSEARCH_MIRROR_INTEGRATION=1 ... tests/elasticsearch-mirror.integration.test.ts` | PASS 5/5 |
| HDFS 存档与恢复 | `HDFS_INTEGRATION=1 ... tests/hdfs-archive.integration.test.ts` | PASS 7/7 |
| 集成合计 | 上述 6 个文件 | PASS：26 用例 |
| Go 测试/静态检查 | `npm run test:go`、`npm run vet:go` | PASS |
| 生产构建 | `npm run build` | PASS |
| macOS 打包 | `npm run package:mac` | PASS：`release/DataMigrator-1.2.1-mac-arm64.dmg` / `.zip`（含 `go-bin`） |
| 打包产物启动 | 直接启动 `DataMigrator.app/Contents/MacOS/DataMigrator` | PASS（进程存活；注意需清除环境变量 `ELECTRON_RUN_AS_NODE`） |

### 4.2 功能与范围

- `feature_list.json`：35/35 feature 均为 pass，覆盖原始 6 条需求与全部增量能力（直连、镜像、HDFS 存档与恢复、事务级回退、风险确认、跨源矩阵、任务并行、模板与编排、Agent/LLM 等）。
- 交付物：源码、`README.md`（功能/开发/打包/数据目录/已知问题）、`docs/architecture.md`（含直连/镜像/存档/恢复章节）、27 个迭代文档、REST/Agent/模板/任务契约说明。

### 4.3 已知问题（移交清单）

| # | 问题 | 影响 | 处置建议 |
|---|---|---|---|
| 1 | 连接密码、SSH/DB 凭据以明文保存在本地配置 | 安全性 | 正式分发前接入 Electron `safeStorage` / 系统钥匙串 |
| 2 | `golang/pgmigrator` 的 CLI `export`/`direct` 路径损坏（COPY 流用法错误），应用内无引用 | 仅影响独立 CLI 使用者 | 后续迭代修复或下架该子命令 |
| 3 | 直连/镜像任务不支持断点续传 | 大任务中断后需回滚重跑 | 已在 UI 与文档中标注；后续可考虑基于日志的续传 |
| 4 | ES 撤销日志为"写前 pending + 写后结果"两段式，崩溃窗口内批次按状态未知处理 | 极端情况下该批次需人工确认 | 记录为设计约束（ES 无事务） |
| 5 | HDFS 存档为 App 自定义 JSONL 分片（非 ES snapshot）；WebHDFS 仅支持 simple 认证 | 与原生 snapshot/Kerberos 环境不兼容 | 需要时增加 snapshot 仓库与 Kerberos 支持 |
| 6 | 镜像/存档尚未接入模板与编排（保存为模板时会跳过并提示） | 无法批量编排镜像任务 | 后续迭代扩展 `TemplateAction` |
| 7 | 后台任务默认并发 4；ES 任务内部并发与任务并发叠加 | 需要按集群容量调参 | 已在 README 已知问题中说明 |
| 8 | ~~`package.json` 版本与 `release/` 旧产物不一致~~ 已解决：版本统一为 **v1.2.1** 并打 tag `v1.2.1`（`release/` 中的历史产物仍为 1.0.0/1.1.x，可按需清理） | 无 | 已解决 |
| 9 | 未配置代码签名/公证 | macOS Gatekeeper 警告、Windows SmartScreen 警告 | 发布前配置 Developer ID 与代码签名证书 |

### 4.4 交付说明

- 运行环境：Node.js + npm；Elasticsearch 导出/导入使用本机 Go 二进制（`npm run build:go` 自动构建）；PostgreSQL/MySQL/SQLite/Hive/Neo4j/Access 走主进程 Node 驱动。
- 数据目录：连接 `userData/connections.json`、任务 `userData/tasks.db`、撤销日志 `userData/tasks/<taskId>.undo.jsonl`、日志 `userData/logs/migration.log`。
- 测试环境（Docker）：`postgres:16`(55432)、Elasticsearch 9.5.0 ×2(9202/9203)、自建 Hadoop 3.4.1 HDFS(9870)。HDFS 测试镜像通过 `bash scripts/build-hdfs-test-image.sh` 构建（不依赖 Docker Hub）。

## 5. 结论

- 移交阶段退出标准满足：验收通过、交付与运行说明完整、已知问题已登记。
- 评估者可据本文件与 `evaluator-rubric.md`、`quality-document.md` 复核。

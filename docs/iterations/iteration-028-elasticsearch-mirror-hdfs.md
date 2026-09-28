# Iteration 028 -- Elasticsearch 同索引镜像迁移与 HDFS 镜像存储

状态：**已实现并通过真实实例验证（跨集群 ES + 真实 HDFS）**

阶段：construction（承接 iteration-026/027 的直连与回滚）

---

## 1. 目标

1. **同索引镜像迁移**：把源集群的索引镜像到目标集群的**同名索引**，镜像包含 settings / mappings（目标不存在时按源定义创建）、可选别名与全部文档，并复用已有的事务级回退。
2. **HDFS 镜像存储**：把索引镜像（元数据 + 数据分片）写到 HDFS，形成可校验的离线镜像存档，供跨环境搬运或归档。
3. 两者都必须在执行前给出风险提示（沿用 `riskAck` 版本校验）。

## 2. 设计

### 2.1 同索引镜像迁移（`elasticsearch-mirror`）

```text
源集群索引 X                                    目标集群索引 X
   |  1. GET /X?flat_settings=true（settings/mappings/aliases）
   |  2. HEAD /X（目标是否存在）
   |     - 不存在 + createTargetIndex -> PUT /X（按源定义创建）
   |     - 存在 + requireMappingMatch -> 字段类型逐项比对，不一致直接失败
   |     - copyAliases -> POST /_aliases（跳过 . 开头系统别名）
   `-> 3. 复用直连迁移链路：scroll / search_after -> _bulk（含撤销日志）
```

- 目标索引名强制等于源索引名，因此不需要（也不允许）单独指定目标名——这就是"同索引镜像"。
- 数据部分完全复用 `directMigrateIndex`：批次进度、取消、撤销日志、`abort/skip` 冲突策略、回滚语义与 iteration-027 一致。
- 回滚额外支持 `dropCreatedTarget`：目标是本次镜像创建的，回滚会连同索引一起删除，避免留下空壳。
- sources/target 指向同一集群时同样工作（同集群重建/覆盖场景）。

### 2.2 HDFS 镜像存档（`elasticsearch-mirror-archive`）

```text
<hdfsDirectory>/
  manifest.json          # status(writing|complete|incomplete)、docCount、parts[{rows,bytes,md5}]、mappingHash
  metadata.json          # settings / mappings / aliases
  data/part-00001.jsonl  # 逐行 {"_id","_routing","_source"}（与既有 ES 导入格式一致）
```

- HDFS 访问走 **WebHDFS**（NameNode HTTP 端口，默认 9870，`user.name` 简单认证）。
- 写作顺序：`metadata.json` -> `manifest.json(status=writing)` -> 数据分片 -> `manifest.json(status=complete)`；每片记录行数、字节数与 md5。
- 失败或取消：尽力写 `status=incomplete` 的 manifest，并按 `cleanupOnFailure`（默认开）删除本次写入的目录；目录已存在时默认 `fail`，需显式 `overwrite` 才会删除重建。
- 分片格式与既有 ES 导入 JSONL 完全一致（`{_id,_routing,_source}`），因此存档可直接用现有导入链路恢复。

### 2.3 与 docker 测试环境的关系

Docker Hub 在当前网络不可达，仓库因此附带**自建 HDFS 测试镜像**的脚本：

```bash
bash scripts/build-hdfs-test-image.sh        # 下载 JDK11 + Hadoop 3.4.1（Apache 镜像）后本地构建
docker run -d --name dm-hdfs-test -p 9870:9870 -p 9864:9864 -p 9000:9000 dm-hdfs-test:1
```

- 基础镜像用本地已有的 `python:3.13.13`，不依赖任何 Hadoop 官方镜像。
- JDK 固定为 11：Hadoop 3.4.1 的 WebHDFS 在 JDK 17 下会触发 JAXB 初始化错误。
- WebHDFS 的 307 重定向指向 DataNode 主机名，容器端口映射场景下客户端可能解析不到；客户端在重定向地址不可达（DNS/连接失败）时会用连接配置的 host 重试一次，保留重定向端口。

## 3. 验收结果

| # | 标准 | 结果 |
|---|---|---|
| 1 | 目标索引不存在时按源定义创建并镜像数据 | PASS（跨集群 9202→9203，25 篇 + mapping 一致） |
| 2 | 回滚删除文档并删除本次创建的目标索引 | PASS（删除 25 篇 + 目标索引 404） |
| 3 | 目标已存在且结构不一致时拒绝镜像 | PASS（`结构与源不一致：字段 name 类型不一致`） |
| 4 | 目标已有数据时只写缺失文档 | PASS（写入 9、跳过 1、目标共 10） |
| 5 | 别名复制可选 | PASS（`copyAliases=true` 时目标出现同名别名） |
| 6 | 同集群同名索引场景可用 | PASS（源=目标集群时全部跳过已存在） |
| 7 | HDFS 基本操作（mkdirs/write/exists/list/read/delete） | PASS（含 overwrite=false 冲突报错） |
| 8 | 存档产物完整可校验 | PASS（manifest=complete、docCount=40、3 分片 15/15/10、md5 齐全） |
| 9 | 分片与既有导入格式一致 | PASS（逐行 `{_id,_source}`，可被导入链路消费） |
| 10 | 目录已存在默认失败、显式 overwrite 才重建 | PASS |
| 11 | 失败时清理未完成存档 | PASS（源索引不存在 -> 目录被删除） |
| 12 | 风险确认不可绕过 | PASS（缺 riskAck 被主进程拒绝；镜像/存档各有专属风险文案） |
| 13 | 应用内端到端 | PASS（Electron + CDP：镜像 40 篇 -> 回滚删索引；存档 40 篇写入 HDFS） |

## 4. 验证命令与证据

```bash
npm run typecheck                      # PASS（node + web）
npm test                               # PASS：26 文件，311 passed / 36 skipped
npm run test:go && npm run vet:go      # PASS
npm run build                          # PASS

# 真实实例（docker：postgres:16 / ES 9.5.0 ×2 / 自建 Hadoop 3.4.1 HDFS）
POSTGRES_INTEGRATION=1 POSTGRES_INTEGRATION_PORT=55432 \
ELASTICSEARCH_INTEGRATION=1 ELASTICSEARCH_INTEGRATION_PORT=9202 \
ELASTICSEARCH_MIRROR_INTEGRATION=1 ELASTICSEARCH_MIRROR_TARGET_PORT=9203 \
HDFS_INTEGRATION=1 HDFS_INTEGRATION_PORT=9870 \
npx vitest run tests/postgres.integration.test.ts tests/postgres-direct.integration.test.ts \
  tests/elasticsearch.integration.test.ts tests/elasticsearch-direct.integration.test.ts \
  tests/elasticsearch-mirror.integration.test.ts tests/hdfs-archive.integration.test.ts
# PASS：6 文件 / 23 用例
```

- 新增 `tests/elasticsearch-mirror.integration.test.ts`（5 用例，跨两个真实集群）与 `tests/hdfs-archive.integration.test.ts`（4 用例，真实 HDFS + 真实 ES）。
- HDFS 存档内容除用自家 WebHDFS 客户端校验外，还用容器内 `hdfs dfs -ls -R` / `-cat` 独立核对。
- Electron + CDP 端到端：`elasticsearch-mirror`（40 篇 → 回滚删索引 → 目标 404）、`elasticsearch-mirror-archive`（40 篇 → HDFS `manifest=complete`）、缺 riskAck 被拒绝、两个模式的表单与风险对话框渲染正确。

## 5. 已知限制

- 镜像迁移要求源文档带 `_id`；目标索引结构不一致时默认拒绝（可关闭校验，但风险自负）。
- 别名复制是"追加"，不会删除目标集群已有的其它别名。
- HDFS 存档不做事务级回滚：失败按 `cleanupOnFailure` 删除本次目录并留下 incomplete manifest。
- 存档格式为 App 自定义 JSONL 分片（非 ES snapshot 格式）；从 HDFS 恢复（HDFS → 目标集群）尚未实现，当前可用既有"导入"链路消费本地 JSONL。
- WebHDFS 仅支持 simple 认证（`user.name`），Kerberos 未实现。

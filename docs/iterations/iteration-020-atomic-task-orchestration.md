# Iteration 020 -- 原子化任务编排

## 目标

统一 no-side-effect 探查原子和任务原子，使 REST、Agent 和 UI 可以线性组合迁移流程。

## 范围

- export preview、import validate、cast dry-run。
- IPC/preload、Agent tools、REST orchestrate。
- task create/cancel/template execute 复用。
- MigrationPage beta 编排模式。
- 编排测试与契约文档。

## 实现

- `OrchestrationService` 负责执行每个 step 并记录 completed/failed/skipped。
- Task 类 atom 只调用 TaskManager.create 入队，不等待执行完成。
- REST 端点在 Bearer Token 鉴权下接收 `{steps}`。
- UI 支持添加、删除、拖拽排序和 JSON 参数编辑。
- Agent 工具 schema 从 11 个扩展到 14 个。

## 验收标准

| # | 标准 | 结果 |
|---|---|---|
| 1 | 三个缺失原子 | PASS |
| 2 | Agent tool schema 补全 | PASS |
| 3 | REST orchestrate + Bearer | PASS |
| 4 | Task 非阻塞入队 | PASS |
| 5 | 线性编排 UI | PASS |
| 6 | orchestration 5 个测试 | PASS |
| 7 | docs/orchestration.md | PASS |

## 验证

```bash
npm run check
npx vitest run tests/orchestration.test.ts --no-cache
npm run build
curl -X POST http://127.0.0.1:3847/api/v1/orchestrate ...
npx electron-builder --mac --dir --config.electronDist=node_modules/electron/dist
```

- 全量测试：230 passed / 15 skipped。
- 编排用例：5/5。
- 开发与本地打包应用的 REST orchestrate 返回正确 cast 结果。

## 已知限制

- 仅支持线性步骤，无 DAG/分支/重试策略。
- Elasticsearch import validate 不查询 mapping 字段，保留动态 mapping 行为。
- 本次 `package:mac` 下载阶段受外部网络阻塞，已用本地 Electron dist 完成目录打包校验。

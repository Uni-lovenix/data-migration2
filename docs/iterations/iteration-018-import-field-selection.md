# Iteration 018 -- 指定字段导入

## 目标

让 PG、MySQL、Elasticsearch、Hive 导入路径支持统一的字段投影，并让桌面端可选择 JSONL 字段。

## 范围

- 四类 Import DTO 的 `selectedColumns`。
- 共享标识符校验、去重和运行时缺失字段检查。
- PG/MySQL/Hive SQL 列投影、ES `_source` 投影。
- 通用字段多选 UI、JSONL 首行解析和模板示例。

## 实现

- `selectedColumns` 为空/缺失时导入全部字段；非空时检查源 JSONL 字段并列出缺失项。
- PG/MySQL/Hive 在记录展开后按源顺序投影，再进入原有 INSERT 批次。
- Elasticsearch Node 与 Go bulk 路径在写入前只保留选中 `_source` 字段。
- `fs:jsonl-columns` 读取第一条非空 JSONL；批次信封取行字段，ES `_source` 取子字段。
- PG/ES 模板示例增加 selectedColumns，模板往返测试覆盖。

## 验收标准

| # | 标准 | 结果 |
|---|---|---|
| 1 | 四类 Import DTO 字段 | PASS |
| 2 | 标识符校验与运行时缺列拒绝 | PASS |
| 3 | PG/MySQL 关系型投影 | PASS |
| 4 | ES bulk `_source` 投影 | PASS |
| 5 | Hive 同构投影 | PASS |
| 6 | 续传游标不受投影影响 | PASS |
| 7 | UI 多选组件与模板示例 | PASS |
| 8 | 4 个 validation + 各引擎 2 个投影测试 | PASS |

## 验证

```bash
npm run check
ELASTICSEARCH_INTEGRATION=1 ELASTICSEARCH_INTEGRATION_PORT=9201 \
  npx vitest run tests/elasticsearch.integration.test.ts --no-cache
npm run build
npm run dev
npm run package:mac
```

- 全量测试：216 passed / 15 skipped。
- 真实 ES：仅导入 name，score 在目标 `_source` 中不存在。
- 开发与打包应用启动成功。

## 已知限制

- 当前按顶层字段名匹配，嵌套路径投影尚未实现。
- 首行用于 UI 字段列表；后续行缺失字段由 Sink 运行时拒绝。

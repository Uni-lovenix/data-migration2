# Iteration 019 -- 类型转换管线

## 目标

在四类导入 Sink 前提供统一的数据类型转换，并支持模板持久化与 UI 配置。

## 范围

- `fieldTransforms` 类型与校验。
- 默认 JSON 兜底。
- json/cast/stringify/skip 策略。
- PG/MySQL/ES/Hive Sink 接入。
- 字段转换 UI 与模板示例。

## 实现

- 共享 `transformRecord` 在投影后、INSERT/bulk 前处理记录。
- cast 覆盖 array→text、map→text、int→bool、ISO→timestamp 和 arrayDelimiter。
- PG/MySQL/Hive 使用目标列类型表；ES Node 与 Go bulk 使用显式规则。
- UI 可逐字段选择源字段、类型、目标字段/类型、策略和数组分隔符。
- PG/ES 示例包含 fieldTransforms，模板往返测试通过。

## 验收标准

| # | 标准 | 结果 |
|---|---|---|
| 1 | 四类 Import DTO fieldTransforms | PASS |
| 2 | 策略与 cast 类型校验 | PASS |
| 3 | 默认 JSON 兜底 | PASS |
| 4 | 四类 cast/stringify/skip | PASS |
| 5 | 四类 Sink 接入 | PASS |
| 6 | UI 折叠面板 | PASS |
| 7 | PG/ES 模板示例 | PASS |
| 8 | 8 个 type-conversion 用例 | PASS |

## 验证

```bash
npm run check
npx vitest run tests/type-conversion.test.ts --no-cache
ELASTICSEARCH_INTEGRATION=1 ELASTICSEARCH_INTEGRATION_PORT=9201 \
  npx vitest run tests/elasticsearch.integration.test.ts --no-cache
npm run build
npm run dev
npm run package:mac
```

- 全量测试：225 passed / 15 skipped。
- 类型转换：8/8 通过。
- 真实 ES：int→boolean 与 selectedColumns 组合通过。

## 已知限制

- 嵌套字段路径转换未实现。
- ES Go 路径的默认类型推导依赖显式 transform，不读取远端 mapping。

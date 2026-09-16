# Iteration 015 -- Hive 数据导入

## 目标

将统一 JSONL 以多值 `INSERT` 追加导入 Hive 表，并保证错误行、续传与取消行为可验证。

## 范围

- Hive 目标列类型读取。
- JSONL 批次信封和逐行记录归一化。
- 多值 `INSERT INTO ... VALUES`。
- 单行类型转换失败跳过及行号诊断。
- `resumeLines` 续传、批次边界取消和追加语义。
- IPC、TaskManager 与 Hive 导入 UI。

## 实现

- `HiveService.importJsonl` 调用 `DESCRIBE` 获取目标列和 data type。
- 每个批次生成一条多值 INSERT，列顺序来自 JSONL 记录字段顺序。
- 转换覆盖字符串、整数、浮点、布尔、日期/时间戳、二进制和复杂类型 JSON。
- 转换失败只跳过对应行并记录 `第 N 行列 C` warning，同批有效行继续提交。
- 只有 INSERT 成功后才推进行游标；Hive 无 upsert，重复导入会追加重复数据。

## 验收标准

| # | 标准 | 结果 |
|---|---|---|
| 1 | `HiveService.importJsonl` DTO | PASS |
| 2 | 多值 INSERT 批量提交 | PASS |
| 3 | 列映射和类型转换错误行跳过 | PASS |
| 4 | JSONL 行游标续传 | PASS |
| 5 | 批次边界取消 | PASS |
| 6 | 基本导入、类型转换、续传测试 | PASS |

## 验证

```bash
npm run check
npx vitest run tests/hive-service.test.ts --no-cache
npm run build
npm run dev
npm run package:mac
```

- 统一检查：18 个测试文件，200 passed / 15 skipped，Go 测试通过。
- HiveService：8/8 通过。
- 开发与打包应用启动成功；REST health 返回 `{"status":"ok"}`。

## 已知限制

- 真实 HiveServer2 集成未运行；协议 mock 覆盖当前导入契约。
- 大量小批次 INSERT 性能有限，生产大数据量可后续扩展到 staging table + LOAD DATA。

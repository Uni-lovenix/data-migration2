# Iteration 017 -- Access 数据导出

## 目标

通过独立 Go 引擎读取 Access 文件并导出统一 JSONL，不向 Electron 引入 ODBC 原生模块。

## 范围

- Access ConnectionConfig 文件路径与密码。
- `golang/accessmigrator` 子进程和 mdbtools 调用。
- 表列表、CSV 流解析、批次 JSONL。
- resume rows、progress/cancel 控制文件。
- IPC、TaskManager、连接管理与 Access 工作台。

## 实现

- `list-tables` 调用 `mdb-tables -1`，支持可选 `-p password`。
- `export` 调用 `mdb-export`，第一行 CSV 作为 columns，其余行按 batchSize 写 `{table,columns,rows}`。
- `--resume-rows` 跳过已处理数据行并追加 `.part`；取消保留 `.part`，普通错误删除。
- Electron `GoAccessService` 使用 progress/cancel 文件与子进程通信。
- 打包时将 accessmigrator 放入 `go-bin`；macOS 与 Windows 二进制均可构建。

## 验收标准

| # | 标准 | 结果 |
|---|---|---|
| 1 | Access ConnectionConfig 与密码 | PASS |
| 2 | Go 子进程技术路线 | PASS |
| 3 | list-tables / export 命令 | PASS |
| 4 | `{table,columns,rows}` JSONL | PASS |
| 5 | resume rows | PASS |
| 6 | UI 文件选择与迁移模式 | PASS |
| 7 | Go 单测覆盖 list/export/cancel | PASS |

## 验证

```bash
npm run check
cd golang/accessmigrator && go test ./...
npm run vet:go
npm run build
npm run build:go:win
npm run dev
npm run package:mac
```

- 全量测试：205 passed / 15 skipped。
- Go 单测：accessmigrator PASS；Windows 交叉编译 PASS。
- 打包应用启动成功，REST health 返回 `{"status":"ok"}`。

## 已知限制

- 当前环境未安装 mdbtools，真实 `.mdb/.accdb` 文件集成未运行。
- `.accdb` 的读取能力取决于 mdbtools/ODBC 版本；必要时后续增加 ODBC adapter。

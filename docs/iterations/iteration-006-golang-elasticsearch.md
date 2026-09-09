# 迭代协议 006：Go 引擎 Elasticsearch 数据导出与导入

## 迭代目标

将 Elasticsearch 导出/导入迁移到独立 Go 引擎，支持大数据量 JSONL 文件流式传输，并继续复用任务队列、进度上报、取消和断点续传。

## 迭代范围

- 新增 `golang/esmigrator` Go 模块，使用标准库实现 Elasticsearch HTTP 客户端。
- Go 引擎支持 scroll 与 search_after（PIT）流式导出，写入 `.part` 临时文件后原子替换。
- Go 引擎支持 JSONL 流式读取与 `_bulk` 分批导入，`create` 跳过冲突、`index` 覆盖写入。
- 通过 `--progress-file` 原子上报进度，通过 `--cancel-file` 在批量边界取消。
- Electron 主进程新增 `GoElasticsearchService`，以子进程方式调用 Go 引擎并保持原 IPC/UI 契约。
- 新增本机与 Windows x64 Go 二进制构建脚本，打包时通过 `extraResources` 携带。
- Go 单元测试覆盖导出、续传、导入冲突和取消。

## 实施计划

1. 创建 Go 模块、CLI 参数和 Elasticsearch 客户端。
2. 实现 scroll / search_after 导出、bulk 导入、进度和取消。
3. 实现 Electron 子进程封装并接入主进程与 TaskManager。
4. 添加 Go 构建脚本、交叉编译和 electron-builder extraResources。
5. 补充 Go 单元测试并更新 CI 的 Go 环境。
6. 更新 README、架构、路线图、功能状态和交接文档。

## 交付物

- `golang/esmigrator` Go 引擎源码、README 与测试。
- `src/main/go-elasticsearch-service.ts` 子进程封装。
- `scripts/build-go.mjs` 与 npm Go 脚本。
- Windows x64 Go 二进制构建验证。
- `npm run check`、`npm run build`、`npm run vet:go` 通过。

## 退出标准

- TypeScript 类型检查无错误。
- 现有单元测试与 Go 单元测试全部通过。
- 生产构建通过。
- Go 本机二进制与 Windows x64 二进制可交叉编译。
- README、架构、路线图、feature 状态和交接文档已更新。

## 结果

- `npm run check` 通过：44 个 JS 单元测试、4 个 Go 测试。
- `npm run build` 通过：产出 main/preload/renderer。
- `npm run build:go` 产出本机 `bin/esmigrator`；`npm run build:go:win` 产出 Windows x64 `bin/esmigrator.exe`。
- `npm run vet:go` 通过。
- Go 引擎使用流式读写、批量进度和取消标记，支持大文件数据导出/导入。
- 真实 Elasticsearch 7.10.2 集成验证通过：scroll 导出 5 行，bulk 导入后重复导入 5 行全部 409 跳过。

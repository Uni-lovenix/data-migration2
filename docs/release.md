# 发布说明

## 产物

`npm run package:mac` 与 `npm run package:win` 会先执行类型检查、单元测试和生产构建，再调用 electron-builder 产出安装包。

- macOS：`release/DataMigrator-<version>-mac-<arch>.dmg` 与 `.zip`
- Windows：`release/DataMigrator-<version>-win-<arch>.exe`（NSIS）

## 验收清单

- [ ] `npm run check` 通过。
- [ ] `npm run build` 通过。
- [ ] 当前平台安装包生成成功。
- [ ] 安装后应用可启动并进入总览页。
- [ ] 新建连接、创建迁移任务和任务中心可正常使用。
- [ ] 已知问题已登记到本文件与 `feature_list.json`。

## 数据与卸载

卸载应用不会自动删除 `userData` 下的连接配置、任务库和日志。需要保留现场时，可先备份整个 `userData` 目录。

## 已知问题

- 任务队列当前为单并发顺序执行；并行迁移能力留待后续迭代。
- 断点续传以批量边界为粒度，批量写入中途取消可能产生重复或缺失。
- 连接密码尚未加密存储，建议发布前接入系统钥匙串或 Electron `safeStorage`。
- Windows NSIS 安装包需要 Windows 环境或 CI 构建；本地 macOS 无法直接验证 NSIS 安装流程。

# Iteration 022 -- LLM API Key safeStorage keystore prefix

## 目标

修复 `LLMStore` 中 safeStorage 加密状态的写入/读取不一致导致的运行时错误，并在不破坏旧记录的前提下向前兼容。

## 范围

- 为 `api_key_encrypted` 列增加版本前缀（`enc1:` / `pln1:`），使读路径能可靠区分密文与明文。
- 修复 `update()` 中将遮罩值 `'''***masked***'''` 当作密文回写的衍生 bug。
- 保留向后兼容：升级前落盘的旧记录（无前缀）走最佳努力分支。
- 加密不可用但记录存在的情况下，给出可读的错误信息。
- 配套 9 个 vitest 用例覆盖写入/读取/旧记录/状态翻转四种组合。

## 实现

- `src/main/llm-store.ts`：
  - `encryptKey` 在 safeStorage 可用时返回 `enc1:<base64-cipher>`，不可用时返回 `pln1:<base64-utf8>`，不再静默丢失明文标记。
  - `decryptKey` 按前缀分派：`pln1:` 直接 base64 解码、`enc1:` 走 `safeStorage.decryptString`（不可用时抛错），无前缀时尝试 decrypt、失败回退原值（救回升级前的明文旧记录）。
  - `update()` 改为读取原始 `api_key_encrypted` 列来保留旧密文，不再依赖被 `mapLLMConfig` 遮罩过的 `existing.apiKey`。
- 新增 `tests/llm-store-encryption.test.ts`，使用 `vi.mock('electron')` 注入可控 `safeStorage`：
  - safeStorage 可用写入 → 加密→解密 round-trip。
  - safeStorage 可用更新 apiKey → 重新加密。
  - safeStorage 可用更新不带 apiKey → 保留旧密文（修 bug）。
  - safeStorage 不可用写入 → 不调用 `encryptString`，读出回原文。
  - safeStorage 不可用写入后再变可用 → 仍可读出原文（状态翻转救活）。
  - 旧记录（无前缀）+ safeStorage 不可用 → 原值返回。
  - 旧记录（无前缀）+ safeStorage 可用 → decryptString 失败时原值返回。
  - 旧记录（无前缀，确为密文）+ safeStorage 可用 → 仍能解密。
  - `enc1:` 记录 + safeStorage 不可用 → 抛出清晰错误信息。

## 验收结果

| # | 标准 | 结果 |
|---|---|---|
| 1 | safeStorage 可用时写入带 `enc1:` 前缀 | PASS |
| 2 | safeStorage 不可用时写入带 `pln1:` 前缀，读取不再误调 decryptString | PASS |
| 3 | `update()` 不传 apiKey 时保留原始密文 | PASS |
| 4 | 升级前的旧明文/旧密文记录都能继续使用 | PASS |
| 5 | 加密不可用但需要解密的记录，提示可读错误 | PASS |
| 6 | typecheck + 全量 vitest + electron-vite build 全绿 | PASS |

## 验证

```bash
npx vitest run tests/llm-store-encryption.test.ts
npx vitest run
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
npx electron-vite build
```
- 新增测试 9/9 通过。
- 全量 vitest 23 个测试文件 / 252 passed / 15 skipped / 0 failed。
- `tsc`（node + web）0 errors。
- `electron-vite build` 产出 out/main、out/preload、out/renderer。

## 已知限制

- `safeStorage` 跨主机迁移：DPAPI 密文仍绑当前用户/主机，把 userData 拷到另一台机器将无法解密 `enc1:` 记录（`pln1:` 旧记录则不受影响）。建议在 CI / 备份流程中明确这一点。
- 旧记录回退路径只在 decryptString 抛错时生效；若以后升级 DPAPI 算法导致旧密文在新版本下解密成功但内容损坏，目前无法区分'成功'与'成功但错'。可后续引入 HMAC 校验。

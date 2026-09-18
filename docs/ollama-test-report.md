# 本地 Ollama LLM 测试报告

测试日期：2026-09-18

## 环境

- macOS arm64，16 GB 内存，8 核。
- Ollama 本地服务：`http://127.0.0.1:11434`。
- 原有模型：`bge-m3`，只支持 embedding，不支持 chat。
- 测试模型：`qwen2.5:1.5b-modelscope`，Qwen2.5 1.5B Instruct，Q4_K_M，支持 tools。
- 模型来源：ModelScope GGUF + Ollama 官方 Qwen2.5 chat/tool 模板。Ollama 官方 CDN 当前限速严重，因此改用 ModelScope 下载后通过 `ollama create` 本地创建。

## 应用层兼容修复

测试过程中发现并修复了以下 Ollama 兼容问题：

1. 普通 LLM 对话接口错误地要求 Ollama 提供 API Key。
2. Agent 响应解析只支持 OpenAI `choices[0].message`，未读取 Ollama 顶层 `message`。
3. Ollama 消息序列化沿用了 OpenAI 的字符串 `arguments` 和 `tool_call_id`，已改为 Ollama 的 object arguments 和无额外 tool id 格式。
4. `cast_dry_run` 工具 schema 缺少嵌套参数定义，已补充 transform 数组和字段约束。

## 测试结果

| 场景 | 结果 | 说明 |
|---|---|---|
| Ollama 基础通话 | PASS | 首次含约 21 秒模型加载；加载后短回答约 0.4 秒。 |
| 应用普通 LLM IPC | PASS | 通过 Electron `window.api.llm.chat` 调用成功，无需 API Key。 |
| 数据迁移领域回答 | PASS | 能给出结构、日期格式、字段映射等基本检查点。 |
| Agent `list_connections` | PASS | 正确调用工具，并准确返回当前 5 个连接及名称。 |
| Agent `cast_dry_run` | PASS | 给出明确参数时正确调用，`active=2` 转换为 `true`。 |
| 结构化 JSON | PARTIAL | 能生成正确 JSON 内容，但会包裹 Markdown code fence，不保证纯 JSON。 |
| 复杂迁移规划 | FAIL | 1.5B 模型在“只规划不执行”任务中产生错误工具调用思路，并把 MySQL 目标误判为 Elasticsearch。 |

## 效果评价

`qwen2.5:1.5b-modelscope` 可以验证完整 Ollama 接入链路，适合：

- 简单中文问答和迁移概念解释。
- 在参数明确时执行单步工具调用。
- 低资源环境下做 UI 联调、连通性和 function calling 冒烟测试。

不适合直接承担：

- 多步骤迁移规划。
- 模糊需求到精确工具参数的转换。
- 严格要求纯 JSON、字段类型和工具选择准确率的 Agent 场景。

建议：

- Agent 日常使用优先选择 7B 及以上模型，例如 Qwen2.5 7B 或更大工具调用模型。
- 1.5B 可作为轻量摘要模型，但不作为迁移执行决策模型。
- macOS 16 GB 内存可运行 7B Q4 模型；高并发或长上下文建议使用 14B 以下的量化模型并限制上下文。

## 复现入口

- 普通 LLM：`window.api.llm.chat(configId, request)`
- Agent：`window.api.agent.chat({ sessionId, userMessage })`
- Ollama 模型：`qwen2.5:1.5b-modelscope`
- Ollama 地址：`http://127.0.0.1:11434`

# MCP 实现原理调研笔记

> 调研 MCP（Model Context Protocol）的协议分层、生命周期、传输层与 Server/Client 能力，作为后续在 Flowix 中接入 MCP 的参考资料。

- 调研日期：2026-06-17
- 协议版本参考：2025-06-18

## 主要来源

- https://modelcontextprotocol.io/docs/learn/architecture
- https://modelcontextprotocol.io/specification/2025-06-18/basic
- https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
- https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- https://modelcontextprotocol.io/specification/2025-06-18/server/resources
- https://modelcontextprotocol.io/specification/2025-06-18/server/prompts
- https://modelcontextprotocol.io/specification/2025-06-18/client/roots
- https://modelcontextprotocol.io/specification/2025-06-18/client/sampling

## 1. MCP 解决什么问题

MCP（Model Context Protocol）是 AI 应用和外部上下文 / 工具之间的标准协议。它不规定模型怎么推理、上下文怎么塞进 prompt，也不规定应用 UI 怎么做；它只规定 host / client / server 之间如何发现能力、交换上下文、调用工具和返回结果。

核心价值：

- 把"模型可用的外部能力"标准化成协议，而不是每个应用单独适配插件。
- 让一个 AI Host 可以连接多个 MCP Server，每个 Server 负责一组资源、工具、提示词或其他能力。
- 用能力协商控制双方可用功能，避免客户端或服务端假设对方一定支持某个扩展。

## 2. 三个角色

- MCP Host：AI 应用本体，比如 IDE Agent、桌面助手、聊天应用。它负责管理用户会话、模型调用、权限 UI、多个 MCP 连接。
- MCP Client：Host 内部为每个 MCP Server 创建的连接组件。一个 client 通常只对应一个 server，负责协议握手、请求 / 响应、通知、超时、取消等。
- MCP Server：暴露上下文和能力的进程或远程服务，例如文件系统、数据库、浏览器、Figma、Slack、GitHub 等能力提供方。

典型关系：

```text
AI Host
  ├─ MCP Client A ── MCP Server A
  ├─ MCP Client B ── MCP Server B
  └─ MCP Client C ── MCP Server C
```

本地 stdio server 通常是一对一连接；远程 Streamable HTTP server 通常可以服务多个 client。

## 3. 协议分层

MCP 可以理解为两层：

- Data layer：基于 JSON-RPC 2.0 的语义层，定义 `initialize`、`tools/list`、`tools/call`、`resources/read` 等方法。
- Transport layer：负责传输 JSON-RPC 消息，目前标准传输包括 stdio 和 Streamable HTTP。

所有实现都必须支持 base protocol 和 lifecycle；其他能力（tools、resources、prompts、sampling、roots）是按需声明和协商的能力。

## 4. 基础消息模型

MCP 所有消息都遵循 JSON-RPC 2.0，分为三类：

- Request：需要对方响应，必须带唯一 id。
- Response：对应某个 request 的 id，返回 result 或 error，两者不能同时存在。
- Notification：单向通知，不带 id，接收方不能回复。

示例：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

实现重点：

- 每个连接会话内 request id 不能重复。
- notification 用于初始化完成、列表变化、资源变化、取消、进度等异步事件。
- 所有请求都应该有超时；长任务可以用 progress notification 说明仍在执行，但仍应有最大超时。

## 5. 生命周期：先协商，后调用

MCP 连接必须先初始化：

1. Client 发送 `initialize`，包含支持的协议版本、client capabilities、client 信息。
2. Server 返回协议版本、server capabilities、server 信息和可选 instructions。
3. Client 发送 `notifications/initialized`，进入正常工作阶段。

关键点：

- 初始化阶段会进行 protocol version negotiation。如果服务端不支持客户端请求的版本，可以返回自己支持的版本；客户端不支持则应断开。
- capabilities 决定后续能不能调用某类方法。比如 server 没声明 tools，client 就不应该调用 `tools/list`。
- HTTP 传输在初始化后需要携带 `MCP-Protocol-Version` 请求头。

## 6. 传输层实现

### stdio

适合本地工具进程：

- Client 启动 server 子进程。
- Client 写 server 的 stdin。
- Server 写 stdout 返回 JSON-RPC 消息。
- 每条消息以换行分隔，消息内部不能有嵌入换行。
- stdout 只能输出合法 MCP 消息；日志必须写 stderr。

实现风险：

- server 如果把普通日志写到 stdout，会污染协议流。
- 进程退出、stdin 关闭、SIGTERM / SIGKILL 是关闭语义的一部分。
- 凭据通常通过环境变量或本地配置传入，不走 MCP HTTP OAuth 规范。

### Streamable HTTP

适合远程或多客户端服务：

- Server 暴露一个 MCP endpoint，例如 `/mcp`。
- Client 用 POST 发送每个 JSON-RPC request / notification / response。
- Server 可以直接返回 `application/json`，也可以返回 `text/event-stream` 用 SSE 流式发送多个消息。
- Client 可以用 GET 打开 SSE 流，接收 server 主动发起的 request / notification。
- Server 可用 `Mcp-Session-Id` 维护有状态会话。

安全要求：

- 校验 Origin，避免 DNS rebinding。
- 本地 HTTP server 应绑定 127.0.0.1，不要默认暴露 0.0.0.0。
- 远程服务要有认证授权。

## 7. Server 能力：Tools / Resources / Prompts

### Tools：模型可调用的动作

Tools 是 model-controlled。模型可以根据上下文自动决定调用，但 host 应该提供用户可见的授权 / 确认 UI。

协议方法：

- `tools/list`：列出工具，支持分页。
- `tools/call`：按工具名和 arguments 调用。
- `notifications/tools/list_changed`：工具列表变化通知，前提是 server 声明 `tools.listChanged`。

工具定义包含：

- name
- title
- description
- inputSchema
- 可选输出 schema / structured content

实现理解：

- Tool 本质是"带 JSON Schema 的远程函数"。
- Host 把 tool schema 暴露给模型，模型产出 tool call，client 用 MCP 发给 server。
- Server 执行真实副作用，例如读数据库、发 HTTP、操作文件、调用 SaaS API。
- 高风险 tool 需要 host 侧做人类确认，而不是只靠 server 自律。

### Resources：应用选择的上下文

Resources 是 application-driven。它们是 server 暴露给 host 的可读上下文，例如文件、数据库 schema、应用数据、日志片段。

协议方法：

- `resources/list`：列出资源，支持分页。
- `resources/read`：读取某个 URI。
- `resources/templates/list`：列出参数化资源模板。
- `resources/subscribe` / `resources/unsubscribe`：订阅资源变化。
- `notifications/resources/list_changed` 和资源更新通知。

实现理解：

- Resource 以 URI 唯一标识，可以是 `file://`、`https://`、`git://` 或自定义 scheme。
- Server 负责把资源内容编码为文本或二进制内容。
- Host 决定是否把资源加入上下文，协议不强制 UI 形态。

### Prompts：用户显式选择的模板

Prompts 是 user-controlled。通常表现为 slash command、命令面板动作或模板列表。

协议方法：

- `prompts/list`：列出 prompt 模板，支持分页。
- `prompts/get`：传入 arguments 后获取具体消息内容。
- `notifications/prompts/list_changed`：prompt 列表变化。

实现理解：

- Prompt 不是直接"执行动作"，而是 server 提供结构化消息模板。
- Host 拿到 prompt 内容后，仍由应用决定如何放进模型上下文。

## 8. Client 能力：Roots / Sampling

### Roots：客户端告诉服务端可访问边界

Roots 是 client 暴露给 server 的文件系统边界。Server 可以请求 `roots/list`，了解自己应该在哪些目录范围内工作。

关键点：

- Root 当前规范里是 `file://` URI。
- Client 可通过 `notifications/roots/list_changed` 通知 server 工作区变化。
- Roots 是安全边界提示，但具体文件访问还要靠 host / sandbox / 权限实现兜底。

### Sampling：服务端反向请求模型生成

Sampling 允许 server 向 client 请求一次 LLM 生成，方法是 `sampling/createMessage`。

关键点：

- Server 不需要自己持有模型 API key。
- Client 保留模型选择、权限、用户审核和实际调用权。
- 适合 server 内部需要 agentic 子任务，例如先让模型分析数据再返回工具结果。
- 规范建议用户可审核 sampling 请求、编辑 prompt、审查生成结果。

## 9. 一次工具调用的端到端流程

1. Host 读取配置，启动或连接 MCP Server
2. MCP Client 发送 `initialize`
3. Server 返回 capabilities: tools / resources / prompts ...
4. Client 发送 `notifications/initialized`
5. Host 调用 `tools/list`，拿到工具 schema
6. Host 把工具 schema 提供给模型
7. 模型决定调用某个工具
8. Host 做权限检查 / 用户确认
9. Client 发送 `tools/call`
10. Server 执行真实操作
11. Server 返回 tool result
12. Host 把结果放回模型上下文，模型生成最终答复

## 10. 实现一个 MCP Server 的最小要点

最小 server 需要：

- 实现 JSON-RPC 收发。
- 支持 `initialize`，返回协议版本和 capabilities。
- 根据声明的 capabilities 实现对应方法。
- 处理 request id、error、notification、超时和取消。
- stdio 模式下严格保证 stdout 只输出协议消息。
- HTTP 模式下实现 POST / GET、SSE、session id、协议版本头和认证。

如果只做一个工具型 server，最小方法集通常是：

- `initialize`
- `notifications/initialized` 处理或忽略
- `tools/list`
- `tools/call`

## 11. 实现一个 MCP Client / Host 的最小要点

最小 client 需要：

- 启动本地 server 或连接远程 server。
- 完成 initialize / version / capability negotiation。
- 按 capability 决定是否请求 tools / resources / prompts。
- 管理 pending request map：`id -> resolver/timeout/cancelToken`。
- 把 server 暴露的工具 schema 转成模型可用的 tool definition。
- 对 tool call 做用户授权、权限限制和审计记录。
- 把 tool / resource / prompt 返回内容转换为 host 的上下文格式。

Host 层还要处理：

- 多 server 命名冲突，例如两个 server 都叫 `search`。
- 工具调用安全分级和确认策略。
- token budget、资源裁剪、上下文优先级。
- 失败降级：server 不可用、版本不兼容、工具超时、权限拒绝。

## 12. MCP 和传统插件系统的区别

- MCP 是协议优先，不绑定某个 host，也不要求插件运行在 host 进程内。
- Server 可以是本地进程，也可以是远程 HTTP 服务。
- Host 和 server 通过 capabilities 协商功能，不需要预先硬编码全部集成细节。
- Tools、Resources、Prompts、Sampling、Roots 把"动作、上下文、模板、模型能力、工作区边界"拆成不同语义层，便于权限和 UI 分开处理。

## 13. 落地设计建议

- 工具调用链路要默认可观测：记录 server、tool name、arguments 摘要、耗时、结果类型、错误。
- 高风险工具要 human-in-the-loop：写文件、发消息、删数据、花钱、访问敏感系统都应确认。
- Resource 不要无限塞上下文：先 list / search，再按需 read，并做 token 裁剪。
- stdio server 要把日志和协议流彻底分离。
- HTTP server 要优先处理 Origin 校验、localhost 绑定、认证和 session 生命周期。
- Server 返回的 schema / description 会直接影响模型是否正确调用工具，应写得像 API 契约，不要只写人类说明。
- 对长耗时工具实现 progress、cancel 和最大超时，避免 host 卡死。

## 14. 一句话总结

MCP 的实现原理可以概括为：Host 为每个外部能力提供方创建一个 MCP Client，通过 JSON-RPC 完成初始化和能力协商，再按协商出的 Tools、Resources、Prompts、Roots、Sampling 等语义接口交换上下文与执行动作；传输层可以是本地 stdio，也可以是支持 SSE / session 的 Streamable HTTP。

## 后续待研究

- 在 Flowix 中作为 Host 接入 MCP 的最小可行方案：进程模型、IPC 协议、UI 形态。
- 工具调用的权限分级模型与用户确认 UX。
- 多 server 命名空间隔离与冲突解决策略。
- 长耗时工具的 progress / cancel 在 ProseMirror 编辑器中的呈现方式。

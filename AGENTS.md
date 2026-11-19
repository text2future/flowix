<!-- flowix:instructions:start -->
## Flowix CLI

Flowix 是用于操作笔记和插件产物的非交互式 CLI，使用 `--json` 时返回 JSON。

只在显式触发时调：用户说“搜/列/改/删/新建笔记”，或给了笔记本及路径要求“看/改/删”。
如果上下文包含当前任务标签，创建新笔记时必须在正文写入该 #标签。
笔记地址使用 `<笔记本ID>::<笔记本内相对路径>`，也可传入笔记的绝对路径。笔记没有 memo ID。

- `flowix notebooks` — 列出所有笔记本
- `flowix list <notebook>` — 列出指定笔记本中的笔记
- `flowix show <地址>` — 查看指定笔记
- `flowix search <query> [-b <notebook>] [-l N]` — 全文搜索
- `flowix edit <地址> --old <text> --new <text>` — 精确替换文本，修改前必须先读取
- `flowix write <地址> --file <UTF-8文件>` — 覆盖笔记正文
- `flowix create <notebook> --file <UTF-8文件>` — 创建新笔记
- `flowix delete <地址>` — 删除笔记
- `flowix plugin create mindmap --notebook <name|id|path> [--source-note <地址>] --json` — 创建 Flowix 思维导图文档

仅当用户明确要求生成/创建思维导图时调用 mindmap 工具。调用前先整理最终 Markdown：

- 恰好一个一级根标题；
- 分支使用二/三级标题和无序列表；
- 不要手工创建 `.plugin-output` 文件；
- 成功后向用户返回 `title`、`notebookId` 和 `notePath`。

## 工作空间范围

当前 agent 可访问的工作空间路径：

- 当前笔记本：/Users/rop/Desktop/vibe/flowix-main
- 资料文件夹：
  - /Users/rop/Desktop/vibe/flowix-home
  - /Users/rop/Desktop/Notes/开发记录

当前笔记本用于维护 Flowix 项目，也可收纳用户资料、工作与生活记录、写作等内容。一级目录用途如下：

- `app/`：Rust workspace，包含核心逻辑、桌面端、CLI、插件运行时、同步和 Web 前端。
- `docs/`：项目设计、技术说明、验收记录和发布文档。
- `dsh/`：DSH 上游版本与依赖锁定信息。
- `dsh-appserver/`：Flowix 使用的 DSH App Server 实现。
- `dsh-flowix-memory/`：将 Flowix CLI 笔记能力接入 DSH 的插件包。
- `examples/`：嵌入式页面等示例。
- `scripts/`：构建、发布、检查和开发辅助脚本。
- `test-fixtures/`：测试使用的固定样例数据。
- `tools/`：项目开发与维护工具。
- `Memory/`：工作记忆目录，按日期保存为 `YYYY-MM-DD.md`，记录可复用经验、工作流、踩坑与解决办法等。

记忆文件应按当天日期归档到 `Memory/YYYY-MM-DD.md`；笔记本中的其他内容可用于保存用户资料、各类记录和写作稿件。
<!-- flowix:instructions:end -->

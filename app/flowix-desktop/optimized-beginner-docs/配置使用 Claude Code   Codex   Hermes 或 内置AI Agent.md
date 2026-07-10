---
key: hvpjzj5w
kind: guide
status: setup
agentRole: agent-setup
keywords:
  - agent
  - claude-code
  - codex
  - hermes
  - flowix-agent
  - setup
---
# 配置使用 Claude Code / Codex / Hermes 或内置 AI Agent

Flowix 支持四种 agent。你可以把它们理解成四种不同的工作入口：内置 AI Agent 更适合在笔记内做总结、改写、生成大纲和问答；Claude Code 更适合项目级 coding 任务、仓库探索和实现计划；Codex 更适合 coding、debug 和结构化实现；Hermes 更适合本地 agent 工作流，以及把 agent 输出沉淀到笔记里。

新手不需要一开始全部配置。先想清楚自己最常做的事：如果主要是整理笔记，先配置内置 AI Agent；如果要让 agent 读取项目并改代码，再配置 Claude Code 或 Codex；如果你已经在使用 Hermes，再把 Hermes 接入 Flowix。

## 配置内置 AI Agent

内置 AI Agent 用于笔记内的日常 AI 操作，例如总结一篇长笔记、改写一段内容、生成大纲，或基于当前笔记回答问题。它不依赖本地 CLI，主要在 Flowix 的 Preferences 里完成配置。

打开 Preferences，进入 Agent 设置，选择 provider。你可以使用 OpenAI、Anthropic、DeepSeek，也可以使用任何 OpenAI 兼容接口。接着填写 model 名称和 API key；如果使用 OpenAI 兼容 provider，还要确认 base URL 是否正确。base URL 填错时，常见表现是连接失败，而不是清楚地提示某个字段错误。

模型选择可以先从稳妥方案开始。日常写作和轻量整理用响应快、成本适中的模型；长篇研究总结或复杂推理任务再换更强的模型；如果你希望内容尽量留在本地，可以选择本地 provider。

配置完成后，打开任意笔记，向 agent 发送一句测试指令：把这篇笔记总结成 5 个要点，并列出还没有回答的问题。如果提示配置缺失，就回到 Preferences 检查 provider、model、base URL 和 API key。

## 给内置 AI Agent 合适的上下文

上下文决定 agent 能看到什么。新手常见问题是一次性加入太多笔记本或文件夹，导致 agent 的回答变慢、变散，甚至抓不住重点。

更好的做法是按任务范围添加上下文。如果问题只和当前笔记有关，就只保留当前笔记；如果要整理某个项目，再加入对应笔记本或文件夹。上下文越贴近问题，agent 越容易给出可用结果。

## 配置 Claude Code

Claude Code 走本地 CLI。Flowix 会启动你电脑上的 Claude Code，并把这次会话连接到笔记里。因此，Flowix 能否使用 Claude Code，取决于你的终端里是否已经能正常运行 `claude`。

先安装 Claude Code，并在 Claude Code CLI 里完成登录。然后打开一个新终端，运行 `claude --version`。如果终端能看到版本号，说明 Flowix 通常也能找到它；如果提示找不到命令，就需要把 Claude Code 的可执行文件加入 PATH，然后重启 Flowix。

在 Flowix 里使用时，打开承载这次工作的文档，进入 Agent 面板，选择 Claude Code。再把相关笔记本、文件夹或项目目录加入上下文，然后给出具体目标，例如让它探索仓库、找出某个模块的入口，或为一个功能写实现计划。

## 配置 Codex

Codex 也走本地 CLI，适合 coding 任务、debug 和仓库级结构化实现。它和 Claude Code 的接入方式相似：Flowix 负责把你的笔记上下文和本地 Codex 会话连接起来。

先安装 Codex CLI，并完成登录或本地配置。接着在新终端里运行 `codex --version`。如果终端能正常输出版本号，就可以回到 Flowix 使用；如果 Flowix 找不到 Codex，通常是 PATH 没有配置好，调整后重启 Flowix 即可。

在 Flowix 里使用 Codex 时，先打开要记录这次工作的笔记，选择 Codex，把项目文件夹加入上下文，再给出明确目标。比如：找出 build 失败的原因，修复某个页面的交互问题，或阅读仓库后总结模块结构。建议一个有意义的任务对应一条 Codex thread，这样后续回顾会更清楚。

Agent 面板里可以选择 model 和 reasoning 强度。新手先用默认设置即可；只有当任务明显需要更强推理时，再提高 reasoning 强度。

## 配置 Hermes

Hermes 适合已经在使用本地 Hermes 工作流的人。把 Hermes 接入 Flowix 后，可以把本地 agent session 和笔记连接起来，让结果自然沉淀到文档里。

先安装 Hermes，并完成登录或本地配置。然后在新终端里运行 `hermes --version`。如果命令不可用，就把 Hermes 的可执行文件加入 PATH，并重启 Flowix。

在 Flowix 中使用 Hermes 时，打开文档，进入 Agent 面板，选择 Hermes Agent。随后加入必要的笔记本或文件夹作为上下文，并给出下一步要产出的结果。不要只给一个宽泛话题，而要说明你希望 Hermes 产出摘要、计划、改写稿，还是可执行清单。

## 常见问题排查

如果某个 agent 起不来，先在新开的终端里运行对应的版本命令。Claude Code 用 `claude --version`，Codex 用 `codex --version`，Hermes 用 `hermes --version`。终端里跑不通，Flowix 通常也跑不通。

如果你刚改过 PATH，需要重启 Flowix。桌面应用不会总是自动读取新终端环境，所以很多“找不到 CLI”的问题都可以通过重启解决。

还要确认该 agent 已经完成认证，目标项目文件夹或笔记本文件夹真实存在，并且当前用户有访问权限。内置 AI Agent 则重点检查 Preferences 里的 provider、model、API key 和 base URL。

#flowix #agent #setup

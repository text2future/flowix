[English](./README.en.md) | **简体中文**

<p align="center">
  <img src="./docs/images/app-icon.png" width="120" alt="Flowix" />
</p>

# 你的笔记，AI 的记忆

Flowix 是一个以文档库为核心的 AI 工作空间。它把项目笔记、资料、规则和 Agent 放在一起，让你看见 Agent 依据什么工作，也能随时修正这些内容。

本地 Markdown · 多 Agent · MCP 与 CLI

[立即下载](https://flowix-memo.com/) · [官网](https://flowix-memo.com/) · [文档](https://flowix-memo.com/docs/)

---

<img src="./docs/images/readme-introduce.gif" width="100%" alt="Flowix" />

## 让 Agent 的工作依据清晰可见

Agent 的回答和产出取决于它读取的资料与遵循的规则。Flowix 将这些上下文放进可浏览、可编辑的文档库。你可以检查资料、调整规则、审阅结果，让后续工作建立在修正后的内容上。

<img src="./docs/images/home-write.png" width="100%" alt="Flowix 笔记在浅色与深色主题中的界面" />

---

## 用笔记本管理项目

每个笔记本都可以作为一个项目空间，集中整理目标、资料、计划和进展。需要时，Agent 可以基于这些内容协助分析问题、整理思路和推进下一步。

适用于产品与软件开发、学习研究、内容创作和个人知识管理。资料与过程持续积累，Agent 可以接着已有上下文工作。

<p align="center"><img src="./docs/images/home-nav.png" width="60%" alt="Flowix 中的笔记、对话、任务与标签导航" /></p>

---

## 让不同 Agent 共用同一套资料

你可以在 Flowix 中使用内置 Agent，也可以连接 Codex、Claude Code、OpenCode、Hermes 等外部 Agent。通过 MCP 或 CLI，让它们按需读取同一个项目空间中的资料，并把结果写回文档。

<p align="center"><img src="./docs/images/home-agent.png" width="60%" alt="Flowix 将 Codex、Claude Code、OpenCode、Hermes 和 Flowix Agent 连接到同一篇笔记" /></p>

---

## 文件留在本地，由你掌控

笔记以普通 Markdown 文件保存在本地。你决定哪些资料提供给 Agent，也可以继续使用熟悉的同步与备份方式。

- 笔记可以用其他应用打开和编辑。
- 连接 Agent 时，按需提供项目资料。
- 使用自己的工具同步和备份文件。

---

## 产品预览

|                            |                         |
| -------------------------- | ----------------------- |
| <img src="./docs/images/gh-detail-1.png" width="100%" alt="笔记列表与标签组织" /><br/>*笔记列表与标签组织* | <img src="./docs/images/gh-detail-2.png" width="100%" alt="笔记详情与 Agent 预设" /><br/>*笔记详情与 Agent 预设* |
| <img src="./docs/images/gh-detail-3.png" width="100%" alt="Agent 模型选择" /><br/>*Agent 模型选择* | <img src="./docs/images/gh-detail-4.png" width="100%" alt="全文与文件搜索" /><br/>*全文与文件搜索* |
| <img src="./docs/images/gh-detail-5.png" width="100%" alt="Provider 与 MCP 配置" /><br/>*Provider 与 MCP 配置* | <img src="./docs/images/gh-detail-6.png" width="100%" alt="代码文件浏览与编辑" /><br/>*代码文件浏览与编辑* |


---

## 快速开始

1. 从 [官网](https://flowix-memo.com/) 下载并安装 Flowix。
2. 新建一个本地文件夹，或将已有文件夹注册为笔记本。
3. 创建一篇文档，记录任务背景、参考资料、目标与约束。
4. 在文档内调用 Agent，或继续用标签与属性组织内容。

## 本地开发

```bash
git clone https://github.com/text2future/flowix.git
cd flowix
npm install

npm run tauri:dev
npm run tauri:build:prod
```

单独运行 `npm run dev` 只启动 Vite 前端，不会启动 Tauri 桌面后端。

桌面开发版 `npm run tauri:dev` 默认连接 `https://cloud.flowix.cc`。正式包 `npm run tauri:build:prod` 始终连接该服务，不会显示环境下拉。单独运行 `npm run dev` 只启动 Vite 前端，不会启动桌面端 Cloud 同步。

开发环境要求 Node.js 20+、Rust 1.75+ 与 Tauri v2；桌面应用支持 macOS 14+ 与 Windows 10+。

## 许可协议

Flowix 基于 [GNU Affero 通用公共许可证第 3 版](LICENSE) 开源（AGPL-3.0-only）。

//! First-run onboarding documents for an empty default notebook.

use super::MemoFile;

struct OnboardingDoc {
    title: &'static str,
    body: &'static str,
}

const ONBOARDING_DOCS: &[OnboardingDoc] = &[
    OnboardingDoc {
        title: "Flowix Memo可以做什么？",
        body: r#"---
kind: guide
status: overview
agentRole: onboarding
keywords:
  - overview
  - what-is
  - value-prop
---
# Flowix Memo 可以做什么？

Flowix Memo 是一款本地优先的笔记应用，把笔记当作"工作素材"而不是"存放仓库"来对待 —— 你写下的内容可以被自己反复回看，也可以交给 AI 代理来加工、总结、改写。

## 它适合什么场景

- **长期沉淀**：笔记以本地 Markdown 文件存在，可备份、可放进自己的同步盘，不被任何一家厂商锁住。
- **按项目分流**：用笔记本（notebook）隔离不同客户、研究方向、个人和工作。打开状态栏的笔记本切换器就能切换上下文。
- **AI 协作**：在文档里直接调用内置 AI 代理或本地 CLI 代理（Claude Code / Codex / Hermes），让代理读你的笔记、给出摘要、改写、行动清单。
- **结构化与轻量化并存**：需要时给笔记加标签和 frontmatter 属性；普通写作就当 markdown 文本随手记。

## 它不适合什么场景

- **协作实时编辑**：Flowix 不是多人协同工具，更偏向"一个人长期积累 + AI 协作"。
- **重型排版 / 富媒体编辑**：核心是 markdown，而不是 Notion 那种 block-based 富文本。
- **需要云端全托管**：默认本地存储，云端同步依赖你自己的同步方案。

## 与一般笔记应用的差异

- 笔记本=文件夹，你能在系统的文件管理器里直接看到 `.md` 文件。
- 标签写在正文里（`#tag`），不需要在侧边栏手动管理分类。
- 笔记属性（frontmatter）随文件一起走，能被任何 markdown 工具读取。
- AI 代理能直接读写你的笔记，不是把内容上传到云端再处理。

## 下一步

- 想了解上手操作：看 **功能介绍：如何快速上手**。
- 想配置 AI 代理：看 **配置使用 Claude Code / Codex / Hermes 或 内置AI Agent**。

#flowix #gettingstarted
"#,
    },
    OnboardingDoc {
        title: "功能介绍：如何快速上手",
        body: r#"---
kind: guide
status: getting-started
agentRole: getting-started
keywords:
  - quickstart
  - notebook
  - tags
  - properties
---
# 功能介绍：如何快速上手

这一篇覆盖 Flowix Memo 的四个最常用操作：建笔记本、加标签、加属性、阅读。

## 创建你的第一个笔记本

笔记本就是一个文件夹。在状态栏右下角切换器点开，新建或注册一个本地目录作为笔记本。

1. 打开状态栏的笔记本切换器。
2. 选择 **新建** 或 **注册**（注册已存在的文件夹）。
3. 给它一个清晰的名字，比如 `研究`、`工作`、`日记`。
4. 确认路径后，Flowix 会在该目录里建立索引。

完成后该文件夹就是你的笔记本 —— 你可以打开系统的文件管理器看到所有 `.md` 文件，可以备份、可以放进自己的同步盘。

## 用标签管理笔记

直接在正文里写标签，例如 `#idea` `#meeting` `#todo`。Flowix 会自动识别并出现在侧边栏的标签过滤器里。

**好标签**描述你将来怎么找到这条笔记：

- `#decision` —— 最终决策
- `#draft` —— 还在改的草稿
- `#reference` —— 之后可能要引用的资料
- `#idea` `#meeting` `#todo` —— 按用途分类

普通写作不需要每条都打标签；只在笔记进入"将来会回头找"的状态时才加。

## 设置笔记属性

标签不够用时，用属性（Properties）。在文档右上角的属性面板里可以加：

- **Status**: Draft / In Progress / Done
- **Type**: Note / Prompt / Todo
- **Source**: 引用链接
- **Keywords**: 搜索关键词

属性存在 markdown frontmatter 里，跟文件一起走；任何兼容 frontmatter 的工具都能读。

## 专注阅读

笔记进入"回看"阶段时，用阅读视图（不是编辑视图）。先读完，再考虑是否需要打标签、加属性、或者交给 AI 代理生成后续动作。

阅读视图特别适合：

- 重新过一遍之前的研究资料
- 在做决策前把上下文梳理一遍
- 把一篇长笔记浓缩成清单

## 速查清单

| 我想... | 用什么 |
|---|---|
| 切到另一个项目的笔记 | 状态栏笔记本切换器 |
| 找带某标签的所有笔记 | 侧边栏标签过滤 |
| 给笔记加结构化字段 | 文档属性面板 |
| 让 AI 读这篇笔记 | Agent 面板 → 添加上下文 → 发送请求 |

#flowix #quickstart
"#,
    },
    OnboardingDoc {
        title: "配置使用 Claude Code / Codex / Hermes 或 内置AI Agent",
        body: r#"---
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
# 配置使用 Claude Code / Codex / Hermes 或 内置AI Agent

Flowix 支持四种 agent，按场景挑一个：

| Agent | 适用 |
|---|---|
| **内置 AI Agent (Flowix Agent)** | 笔记内的总结、改写、生成大纲、问答 |
| **Claude Code** | 项目级 coding 任务、探索仓库、做实现计划 |
| **Codex** | coding 任务、debug、仓库级结构化实现 |
| **Hermes** | 本地 agent 工作流、捕获 agent 输出到笔记 |

下面分别讲怎么配置。

## 配置内置 AI Agent (Flowix Agent)

1. 打开 **Preferences**。
2. 切到 **Agent** 设置。
3. 选择 provider（OpenAI / Anthropic / DeepSeek / 任何 OpenAI 兼容接口）。
4. 填入 model 名。
5. 填 API key（如 provider 需要）。
6. 保存后开始一个新对话。

OpenAI 兼容 provider 还要确认 base URL。URL 错了通常表现为"连接错误"而不是明确提示。

**挑模型的经验法则**：日常写作用平衡且响应快的；长篇研究总结用强推理模型；想离线用本地 provider。

**给 agent 合适的上下文**：上下文决定 agent 看什么。按需加当前笔记本、文件夹或单文件 —— 不要无脑全加。问题只需要看一篇笔记时，scope 就只留那篇。

**快速测试**：保存设置后打开任意笔记，发：

> 把这篇笔记总结成 5 个要点并列出还没回答的问题。

如果 agent 说"配置缺失"，回 Preferences 检查 provider / model / base URL / API key。

## 配置 Claude Code

Claude Code 走本地 CLI。Flowix 启动该 CLI 并把会话连到笔记里。

**准备本地 CLI**：

1. 安装 Claude Code。
2. 在 Claude Code CLI 里完成登录。
3. 终端跑 `claude --version`，确认能找到。
4. 找不到就把可执行文件加到 PATH，然后重启 Flowix。

Flowix 用的是你终端能跑的那个 `claude`。终端跑不通，Flowix 也跑不通。

**在 Flowix 里用**：

1. 打开文档。
2. 打开 Agent 面板。
3. 选择 `Claude Code`。
4. 把需要的笔记本 / 文件夹加进上下文。
5. 给出具体目标。

## 配置 Codex

Codex 走本地 Codex CLI，适合 coding 任务和仓库探索。

**准备本地 CLI**：

1. 安装 Codex CLI。
2. 完成登录 / 配置。
3. 终端跑 `codex --version`。
4. Flowix 找不到就把可执行文件加到 PATH，重启 Flowix。

**运行选项**：在 Agent 面板里能选 model 和 reasoning 强度。除非任务明显需要更强推理，先用默认。

**在 Flowix 里用**：

1. 打开要承载这次工作的笔记。
2. 选择 `Codex`。
3. 把项目文件夹加进上下文。
4. 提具体目标，例如"找出 build 失败的原因"。

一个有意义的任务一条 Codex thread —— 笔记将来好回顾。

## 配置 Hermes

Hermes 走本地 Hermes CLI。已经在用 Hermes 的人、或想把 Hermes session 挂到笔记里时用。

**准备本地 CLI**：

1. 安装 Hermes。
2. 完成登录或本地配置。
3. 终端跑 `hermes --version`。
4. 找不到就加到 PATH，重启 Flowix。

**在 Flowix 里用**：

1. 打开文档。
2. 打开 Agent 面板。
3. 选择 `Hermes Agent`。
4. 把笔记本 / 文件夹加进上下文。
5. 给下一步有用的结果，不是给一个宽泛话题。

## 通用排查清单

不论哪种 agent 起不来，先查：

1. CLI 在**新开的终端**里能跑（`claude --version` / `codex --version` / `hermes --version`）。
2. PATH 改动之后**重启了 Flowix**。
3. 已完成该 agent 的认证。
4. 目标项目文件夹 / 笔记本文件夹存在并可访问。
5. 内置 AI Agent 的情况：Preferences 里 provider / model / API key / base URL 都填了。

#flowix #agent #setup
"#,
    },
];

impl MemoFile {
    /// Seed onboarding documents into a newly created notebook.
    ///
    /// Called every time `create_notebook` runs — there is no global "first run"
    /// gate anymore, so each fresh notebook gets its own set of guide docs.
    ///
    /// Safety guard: if the target folder already contains memos (e.g. the user
    /// registered an existing folder full of notes), this is a no-op rather than
    /// injecting 5 onboarding docs into someone else's content.
    pub fn seed_onboarding_docs(&self) -> std::io::Result<bool> {
        if self
            .read_index()
            .map(|index| !index.memos.is_empty())
            .unwrap_or(false)
        {
            return Ok(false);
        }

        for doc in ONBOARDING_DOCS {
            self.create_memo(doc.title, doc.body, None)?;
        }

        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::memo_file::{MemoFile, MemoIndexFile, NotebookConfig};

    fn test_memo_file() -> (tempfile::TempDir, MemoFile) {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("data");
        let config_dir = dir.path().join("config");
        fs::create_dir_all(&app_data).unwrap();
        fs::create_dir_all(&config_dir).unwrap();

        let notebook_path = dir.path().join("Default Notebook");
        fs::create_dir_all(&notebook_path).unwrap();
        let notebook_file = config_dir.join("notebook.json");
        let mut mf = MemoFile::new(app_data, notebook_file);
        let config = NotebookConfig {
            id: "nb_default".to_string(),
            name: "Default Notebook".to_string(),
            icon: None,
            path: format!("{}/", notebook_path.to_string_lossy()),
            is_default: true,
            created_at: 1,
            updated_at: 1,
        };
        mf.write_notebook_configs(&[config]).unwrap();
        mf.set_current_notebook(Some("nb_default".to_string()));
        (dir, mf)
    }

    #[test]
    fn seeds_docs_into_empty_default_notebook() {
        let (_dir, mf) = test_memo_file();

        assert!(mf.seed_onboarding_docs().unwrap());
        let index = mf.read_index().unwrap();
        assert_eq!(index.memos.len(), ONBOARDING_DOCS.len());
        assert!(index
            .memos
            .iter()
            .any(|memo| memo.filename == "Flowix Memo可以做什么？.md"));

        // 同一个 notebook 已有 memos → 跳过, 数量不变
        assert!(!mf.seed_onboarding_docs().unwrap());
        assert_eq!(mf.read_index().unwrap().memos.len(), ONBOARDING_DOCS.len());
    }

    #[test]
    fn does_not_seed_when_notebook_already_has_notes() {
        let (_dir, mf) = test_memo_file();

        mf.create_memo("Existing Note", "# Existing Note\n", None)
            .unwrap();
        assert!(!mf.seed_onboarding_docs().unwrap());
        assert_eq!(mf.read_index().unwrap().memos.len(), 1);
    }

    #[test]
    fn reseeds_after_clearing_index_for_a_fresh_notebook() {
        // 模拟"又建了一个新空 notebook"：清空 memo index 后再调一次，
        // 应当重新写入 5 篇引导 ── 不再有全局首次守卫。
        let (_dir, mf) = test_memo_file();

        assert!(mf.seed_onboarding_docs().unwrap());
        assert_eq!(mf.read_index().unwrap().memos.len(), ONBOARDING_DOCS.len());

        mf.write_index(&MemoIndexFile::default()).unwrap();
        assert!(mf.seed_onboarding_docs().unwrap());
        assert_eq!(mf.read_index().unwrap().memos.len(), ONBOARDING_DOCS.len());
    }
}

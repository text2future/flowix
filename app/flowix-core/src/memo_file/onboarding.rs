//! First-run onboarding documents for an empty default notebook.

use super::MemoFile;

struct OnboardingDoc {
    title: &'static str,
    body: &'static str,
}

// 数组顺序与最终展示顺序相反: `seed_onboarding_docs` 按数组顺序 push,
// 每条 memo 拿到的 createdAt 单调递增; 前端默认按 `createdAt` desc 排序
// (最新在前). 因此"想展示在最上"的文档必须放在数组**末尾**, 才能拿到
// 最大的 createdAt. 期望的展示顺序 (从上到下):
//   1. Flowix Memo 产品介绍
//   2. 如何快速上手
//   3. 配置使用 AI Agent
const ONBOARDING_DOCS: &[OnboardingDoc] = &[
    OnboardingDoc {
        title: "配置使用 AI Agent",
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
# 配置使用 AI Agent

Flowix Memo 支持多种 agent。你可以用内置 AI Agent 处理笔记内容，也可以连接 Claude Code、Codex、Hermes 这类本地 CLI 代理来完成更复杂的工作。

甚至可以在文档内，使用 Codex / Claude Codex 进行项目开发。

&nbsp;

## Flowix Agent 适合什么

内置 Flowix Agent 适合直接处理笔记内容，例如总结一篇长笔记、把草稿改成更清楚的版本、生成提纲、列出问题，或基于当前笔记做问答。

Flowix Agent 需要在 偏好设置 / AI Agent 中正确配置模型后进行使用。

## Claude Code 适合什么

Claude Code 适合项目级 coding 任务。比如探索一个仓库、理解代码结构、制定实现计划、分析跨文件逻辑，或者围绕代码改动进行较长的技术任务。

它通过本地 CLI 运行。Flowix Memo 会启动你本机可用的 `claude` 命令，并把会话连接到当前笔记。

## Codex 适合什么

Codex 适合 coding、debug 和仓库级结构化实现。你可以把项目文件夹加进上下文，然后让 Codex 查找 build 失败原因、实现某个功能、补测试或解释代码结构。

一个有意义的任务建议开一条独立 Codex thread。这样将来回看笔记时，能清楚知道这次代理会话解决了什么问题。

## Hermes 适合什么

Hermes 适合已经在使用 Hermes 本地工作流的人。你可以把 Hermes session 接到笔记里，让代理输出、任务过程和后续整理都留在 Flowix Memo 的上下文中。

使用 Hermes 时，目标要具体。与其给一个宽泛话题，不如直接说明你希望 Hermes 产出什么结果。

&nbsp;

## AI 配置通用排查

如果 agent 起不来，先在新开的终端里确认 CLI 能运行。Claude Code 对应 `claude --version`，Codex 对应 `codex --version`，Hermes 对应 `hermes --version`。

确认 PATH 改动后已经重启 Flowix Memo。很多 CLI 明明已经安装，但应用仍然找不到，原因就是 Flowix Memo 启动时读到的 PATH 还是旧的。

再确认你已经完成对应 agent 的认证，目标项目文件夹或笔记本文件夹也真实存在并且可访问。

如果问题出在内置 AI Agent，重点检查 Preferences 里的 provider、model、API key 和 base URL。只要其中一项不匹配，就可能出现连接失败或模型不可用。

#flowix #agent #setup
"#,
    },
    OnboardingDoc {
        title: "如何快速上手",
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
# 如何快速上手

这一篇介绍 Flowix Memo 最常用的四件事：

- 创建笔记本
- 使用标签
- 设置属性
- 以及在阅读视图里回看内容。

先掌握这几项，就可以开始稳定地记录和整理资料。

&nbsp;

## 1.1 创建你的第一个笔记本

笔记本就是一个本地文件夹。你可以新建一个空文件夹作为笔记本，也可以注册一个已经存在的文件夹，让 Flowix Memo 管理里面的 Markdown 文件。

打开状态栏右下角的笔记本切换器，选择新建或注册。新建适合从零开始记录，注册适合把已有的资料目录接入 Flowix Memo。

给笔记本起一个清楚的名字，例如 `研究`、`工作`、`日记` 或某个项目名。名字越明确，将来切换上下文时越不容易混淆。

确认路径后，Flowix Memo 会为这个目录建立索引。完成后，你可以在系统文件管理器里看到笔记本里的 `.md` 文件，也可以把这个文件夹放进自己的同步盘或备份方案。

## 1.2 用标签管理笔记

标签直接写在正文里，例如 `#idea`、`#meeting`、`#todo`。Flowix Memo 会自动识别这些标签，并在侧边栏的标签过滤器里显示出来。

好的标签应该描述你将来会怎样找回这条笔记。比如，`#decision` 适合标记最终决策，`#draft` 适合标记仍在修改的草稿，`#reference` 适合标记以后可能引用的资料。

标签不需要一开始就加满。普通记录可以先专心写内容，等这条笔记变成"以后还会回头找"的资料时，再补上合适的标签。

## 1.3 用属性补充结构化信息

当标签不够用时，可以使用属性。属性适合记录状态、类型、来源、关键词这类更稳定的信息。

常见的属性包括 Status、Type、Source 和 Keywords。Status 可以表示 Draft、In Progress 或 Done；Type 可以表示 Note、Prompt 或 Todo；Source 可以保存引用链接；Keywords 可以补充搜索关键词。

这些属性会保存在 Markdown 文件顶部的 frontmatter 里。它们会跟着文件一起移动和备份，也能被兼容 frontmatter 的工具读取。

#flowix #quickstart
"#,
    },
    OnboardingDoc {
        title: "Flowix Memo 产品介绍",
        body: r#"---
kind: guide
status: overview
agentRole: onboarding
keywords:
  - overview
  - what-is
  - value-prop
---
# Flowix Memo 产品介绍

&nbsp;

**Flowix** Memo 是一款高颜值、本地优先的笔记应用。

另外，和传统 Notion、Obsidian 等不同，Flowix ==聚焦在管理 AI 输入，AI 对话==。是提升 AI 使用效率的不可错过的方案之一。

Flowix 将文档即是最高优先级元素。传统产品使用 AI 管理文档，而 Flowix 则是通过文档管理 AI，让 AI 的行为被记录下来，实现 人的写作、AI 生成内容都能被有效地管理起来。

&nbsp;

## 1. 适合长期沉淀资料

Flowix Memo 的笔记以本地 Markdown 文件保存。你能在系统文件夹里直接看到这些 `.md` 文件，也可以用自己的同步盘、备份工具或版本管理方式来保存它们。

这种方式的好处是，你的内容不会被锁在某个专有云服务里。以后即使换工具，笔记仍然是普通 Markdown 文件，可以被其他编辑器继续读取。

## 2. 适合按项目管理上下文

Flowix Memo 用笔记本来组织内容。一个笔记本就是一个本地文件夹，你可以把工作、研究、客户项目、日记或资料库分别放在不同笔记本里。

当你切换笔记本时，Flowix 会切换当前上下文。这样你在写某个项目时，不会被其他项目的笔记干扰；调用 AI 代理时，也更容易只提供相关资料。

## 3. 适合和 AI 一起处理笔记

Flowix Memo 支持在文档里调用内置 AI Agent，也可以连接 Claude Code、Codex、Hermes 等本地 CLI 代理。代理可以读取你指定的笔记或文件夹，然后帮你做总结、改写、问答、计划拆解和代码相关任务。

关键点是，你可以控制代理能看到什么。只给它当前笔记、某个文件夹或整个笔记本，取决于这次任务需要多少上下文。

## 4. 适合轻量写作和结构化管理并存

日常记录时，你可以把 Flowix Memo 当成普通 Markdown 编辑器，直接写标题、段落和清单。需要管理时，再给笔记加标签或属性。

标签写在正文里，比如 `#idea` 或 `#meeting`。属性写在 Markdown frontmatter 里，例如状态、类型、来源和关键词。这些信息会跟着文件一起保存，也能被其他兼容 Markdown 的工具读取。

&nbsp;

#flowix #gettingstarted
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
        let mut mf = MemoFile::new(config_dir);
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
            .any(|memo| memo.filename == "Flowix Memo 产品介绍.md"));

        // 顺序契约: 数组是反向写的, 索引里最后 push 的拿最大 createdAt,
        // 前端 desc 排序后展示在最上. 验证索引顺序:
        //   index[0] (oldest, displayed bottom) = "配置使用 AI Agent"
        //   index[last] (newest, displayed top) = "Flowix Memo 产品介绍"
        let filenames: Vec<String> = index.memos.iter().map(|m| m.filename.clone()).collect();
        assert_eq!(
            filenames.last().unwrap(),
            "Flowix Memo 产品介绍.md",
            "最后 push 的应是最顶部展示的, 否则前端 createdAt desc 会把第一篇挤到底部"
        );
        assert_eq!(
            filenames.first().unwrap(),
            "配置使用 AI Agent.md",
            "最先 push 的应是最底部展示的"
        );

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

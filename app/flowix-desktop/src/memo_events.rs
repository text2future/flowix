//! 统一笔记事件总线 — 所有"写者" (用户 UI / Agent / 外部工具) 在改完磁盘后
//! 都 emit 这一个事件, 前端一个 `listen()` 派发到 store + 编辑器。
//!
//! 设计要点:
//! - 单一事件名 `MEMO_EVENT`, `#[serde(tag = "kind")]` 内部区分 `created` /
//!   `updated` / `deleted`。复用 [`crate::agent_flowix::AgentChunk`] 的判别式 enum 模式。
//! - `MemoChangeSource` 是 informational, 不影响路由。前端不用它分支, 仅供
//!   日志 / toast / 自写抑制的二次判断使用。
//! - 旧事件 `agent-document-updated` 由 [`crate::agent_flowix`] 的 `edit` 工具触发,
//!   本次重构废弃, 改由本模块的 `Updated` 变体承载。

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use flowix_core::memo_file::Memo;

pub const MEMO_EVENT: &str = "memo-event";

/// 写者标识 — 仅 informational, 前端不用于分支路由。
///
/// Plan B 后 Agent 不再手动 emit, watcher 把 Agent / 外部工具的磁盘
/// 变更统一归到 `ExternalTool`。`AgentEdit` / `AgentWrite` 这两个变体
/// 已删除 (历史 comment 提到「前端不用它分支」, 合并后语义一致)。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum MemoChangeSource {
    /// 用户点 "+" 新建空笔记
    UserNew,
    /// "Save to Memo" 按钮导入外部文件
    UserImport,
    /// 用户在编辑器保存, 走 `update_memo_db` / `write_document`
    UserEdit,
    /// 外部编辑器 / 其他 AI / Agent 改磁盘, 文件监听器观察到 ──
    /// v3 后所有非用户主动保存的路径都合到这里
    ExternalTool,
}

/// Derived memo fields that changed as a result of the write.
///
/// This is only a refresh signal for the frontend. Tags and todo totals are
/// notebook-wide derived views, so the frontend should re-query them when the
/// corresponding flag is true instead of trying to patch them locally.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoDerivedChanged {
    pub tags: bool,
    pub todos: bool,
    pub agents: bool,
}

impl MemoDerivedChanged {
    pub fn from_memos(before: Option<&Memo>, after: &Memo) -> Self {
        Self {
            tags: before
                .map(|memo| memo.tags.as_slice() != after.tags.as_slice())
                .unwrap_or_else(|| !after.tags.is_empty()),
            todos: before
                .map(|memo| memo.todos.as_slice() != after.todos.as_slice())
                .unwrap_or_else(|| !after.todos.is_empty()),
            agents: before
                .map(|memo| memo.agents.as_slice() != after.agents.as_slice())
                .unwrap_or_else(|| !after.agents.is_empty()),
        }
    }

    pub fn from_deleted(memo: &Memo) -> Self {
        Self {
            tags: !memo.tags.is_empty(),
            todos: !memo.todos.is_empty(),
            agents: !memo.agents.is_empty(),
        }
    }
}

/// 笔记事件。前端 `useMemoEvents` 收到后按 `kind` 派发到 store action。
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MemoEvent {
    /// 新笔记落盘 (新建 / 拖拽 / 粘贴 / import / Agent write 新文件)
    Created {
        memo: Memo,
        #[serde(rename = "notebookId")]
        notebook_id: String,
        #[serde(rename = "derivedChanged")]
        derived_changed: MemoDerivedChanged,
        source: MemoChangeSource,
    },
    /// 现有笔记的 preview / tags / todos / `updatedAt` 变化 (用户编辑 /
    /// Agent edit / 外部工具改磁盘 / 收藏状态变化)。`path` 用于前端编辑器
    /// path 匹配。
    Updated {
        id: String,
        path: String,
        #[serde(rename = "notebookId")]
        notebook_id: String,
        /// v2 rename / update: 后端 emit 前从 memo index 读出当前 memo,
        /// 附在 payload 里一起发给前端。前端按 id 决定是 update (已在 memos 里替换)
        /// 还是 insert (不在 memos 里 push), 不需要 readMemo IPC, 也不用 path 对比
        /// filename 分流。
        memo: Memo,
        #[serde(rename = "derivedChanged")]
        derived_changed: MemoDerivedChanged,
        source: MemoChangeSource,
    },
    /// 笔记被删除 (用户删除 / `clear_memos` / 外部工具 rm 文件)
    Deleted {
        id: String,
        path: String,
        #[serde(rename = "notebookId")]
        notebook_id: String,
        #[serde(rename = "derivedChanged")]
        derived_changed: MemoDerivedChanged,
    },
}

impl MemoEvent {
    /// 事件关联的 memo id。Deleted 总是有 id; Created 从 memo 里拿; Updated
    /// 直接读字段。没有 id (例如 unregister_memo_by_path 后的 Deleted) 返回
    /// 当前未在业务逻辑中分支使用; 保留作内部接口。
    pub(crate) fn memo_id(&self) -> &str {
        match self {
            MemoEvent::Created { memo, .. } => &memo.id,
            MemoEvent::Updated { id, .. } => id,
            MemoEvent::Deleted { id, .. } => id,
        }
    }
}

/// 触发 emit 的薄包装。失败不 panic (let _ = 吞掉 emit 错误, 跟 `agent-chunk`
/// 的 emit 风格保持一致 — IPC 通道关闭时不该让业务逻辑崩)。
///
/// v3 改造后物理 rename 不再发生, 不再需要 id 二级兜底。
pub fn emit(app: &AppHandle, event: MemoEvent) {
    // 优先走 dispatcher (SharedDispatcher) 抽象, 拿不到退到直接 app.emit。
    // dispatcher 在 lib.rs::run 里 manage, 为未来多 channel (attachment /
    // tag / notebook) 提供统一入口。本函数是业务唯一调用点, 不
    // 需要动 agent.rs / commands/* 一行代码。
    if let Some(dispatcher) = app.try_state::<crate::events::SharedDispatcher>() {
        emit_via_dispatcher(&dispatcher, event);
    } else {
        let _ = app.emit(MEMO_EVENT, &event);
    }
}

/// 通过 dispatcher 派发 — 走 `crate::events::EventDispatcher`
/// 抽象。 `emit()` 默认优先走这里 (从 `app.state` 拿 dispatcher 实例),
/// 拿不到才退到 `app.emit` 直接发。 多 channel 扩展 (attachment-event /
/// tag-event) 在 dispatcher 里增加, 业务调用点仍走 `emit()`。
///

pub fn emit_via_dispatcher(dispatcher: &crate::events::SharedDispatcher, event: MemoEvent) {
    let _ = event.memo_id();
    let payload = serde_json::to_value(&event).expect("MemoEvent serialization must not fail");
    dispatcher.publish(MEMO_EVENT, payload);
}

#[cfg(test)]
mod tests {
    //! serde wire-format 测试 — 保证与前端 TypeScript 镜像 (app/flowix-web/types/memo.ts)
    //! 的硬契约。`kind` 必须是 snake_case, 字段命名 (memo/id/path/source) 是
    //! 跨 IPC 边界的硬约定, 不要随便改。

    use super::*;
    use flowix_core::memo_file::Memo;

    fn sample_memo() -> Memo {
        Memo {
            id: "abc123".to_string(),
            filename: "Sample.md".to_string(),
            preview: "preview text".to_string(),
            thumbnail: Some("https://example.com/cover.png".to_string()),
            tags: vec!["t1".to_string()],
            todos: vec![],
            agents: vec![],
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            favorited: false,
            icon: None,
            colors: vec![],
            properties: serde_json::json!({}),
        }
    }

    #[test]
    fn created_serializes_with_snake_case_tag_and_camelcase_memo() {
        let event = MemoEvent::Created {
            memo: sample_memo(),
            notebook_id: "nb_default".to_string(),
            derived_changed: MemoDerivedChanged {
                tags: true,
                todos: false,
                agents: false,
            },
            source: MemoChangeSource::UserNew,
        };
        let v: serde_json::Value = serde_json::to_value(&event).unwrap();
        assert_eq!(v["kind"], "created");
        assert_eq!(v["source"], "user_new");
        assert_eq!(v["notebookId"], "nb_default");
        assert_eq!(v["derivedChanged"]["tags"], true);
        // memo 字段保持 camelCase (Memo struct 自身用 #[serde(rename = "createdAt")] 等)
        assert_eq!(v["memo"]["id"], "abc123");
        assert_eq!(v["memo"]["filename"], "Sample.md");
        assert_eq!(v["memo"]["thumbnail"], "https://example.com/cover.png");
        assert_eq!(v["memo"]["createdAt"], 1_700_000_000_000i64);
    }

    #[test]
    fn updated_serializes_with_snake_case_tag() {
        let event = MemoEvent::Updated {
            id: "m_abc".to_string(),
            path: "/tmp/foo.md".to_string(),
            notebook_id: "nb_default".to_string(),
            memo: sample_memo(),
            derived_changed: MemoDerivedChanged::default(),
            source: MemoChangeSource::ExternalTool,
        };
        let v: serde_json::Value = serde_json::to_value(&event).unwrap();
        assert_eq!(v["kind"], "updated");
        assert_eq!(v["id"], "m_abc");
        assert_eq!(v["path"], "/tmp/foo.md");
        assert_eq!(v["source"], "external_tool");
    }

    #[test]
    fn deleted_serializes_with_snake_case_tag() {
        let event = MemoEvent::Deleted {
            id: "m_abc".to_string(),
            path: "/tmp/foo.md".to_string(),
            notebook_id: "nb_default".to_string(),
            derived_changed: MemoDerivedChanged {
                tags: false,
                todos: true,
                agents: false,
            },
        };
        let v: serde_json::Value = serde_json::to_value(&event).unwrap();
        assert_eq!(v["kind"], "deleted");
        assert_eq!(v["id"], "m_abc");
        assert_eq!(v["path"], "/tmp/foo.md");
        assert_eq!(v["notebookId"], "nb_default");
        assert_eq!(v["derivedChanged"]["todos"], true);
    }

    #[test]
    fn all_sources_have_snake_case_strings() {
        // 防止日后加新 source 时漏掉 rename_all 导致 IPC 失配
        for (variant, expected) in [
            (MemoChangeSource::UserNew, "user_new"),
            (MemoChangeSource::UserImport, "user_import"),
            (MemoChangeSource::UserEdit, "user_edit"),
            (MemoChangeSource::ExternalTool, "external_tool"),
        ] {
            let s: String = serde_json::to_value(&variant)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string();
            assert_eq!(s, expected, "source variant wire mismatch");
        }
    }
}

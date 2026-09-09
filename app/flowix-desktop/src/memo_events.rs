//! Unified memo event bus for UI, Agent, cloud, and external-editor writes.
//!
//! Created, updated, and deleted mutations share `MEMO_EVENT`. Content
//! commits carry revision/changeId metadata, while in-app editor writes also
//! carry originWindowLabel so only sibling windows reload the committed bytes.
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::document_mutation::{DocumentCommit, DocumentMutationCoordinator};
use crate::lock_utils::read_lock;
use flowix_core::memo_file::Memo;

pub const MEMO_EVENT: &str = "memo-event";

/// 写者标�?—�?informational, 前�?不用于分�?��由�?///
/// Plan B �?Agent 不再手动 emit, watcher �?Agent / 外部工具的�?�?/// 变更统一归到 `ExternalTool`。`AgentEdit` / `AgentWrite` 这两�?���?/// 已删�?(历史 comment 提到「前�?��用它分支�? 合并后�?义一�?�?
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum MemoChangeSource {
    /// 用户�?"+" 新建空笔�?
    UserNew,
    /// "Save to Memo" 鎸夐挳瀵煎叆澶栭儴鏂囦欢
    UserImport,
    /// 用户在编辑器保存或改名 (`write_document` / `rename_memo_title`).
    UserEdit,
    /// User explicitly deleted a note.
    UserDelete,
    /// 外部编辑�?/ 其他 AI / Agent 改�?�? 文件监听器�?察到 ──
    /// v3 鍚庢墍鏈夐潪鐢ㄦ埛涓诲姩淇濆瓨鐨勮矾寰勯兘鍚堝埌杩欓噷
    ExternalTool,
    /// Flowix Cloud pull applied this write locally. Automatic push scheduling
    /// must ignore this source to avoid a sync loop.
    CloudSync,
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

/// 笔�?事件。前�?`useMemoEvents` 收到后按 `kind` 派发�?store action�?
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MemoEvent {
    /// 新笔记落�?(新建 / 拖拽 / 粘贴 / import / Agent write 新文�?
    Created {
        memo: Memo,
        #[serde(rename = "notebookId")]
        notebook_id: String,
        #[serde(rename = "derivedChanged")]
        derived_changed: MemoDerivedChanged,
        source: MemoChangeSource,
    },
    /// 现有笔�?�?preview / tags / todos / `updatedAt` 变化 (用户编辑 /
    /// Agent edit / 外部工具改�?�?/ 收藏状态变�?。`path` 用于前�?编辑�?
    /// path 匹配�?
    Updated {
        id: String,
        path: String,
        #[serde(rename = "notebookId")]
        notebook_id: String,
        /// v2 rename / update: 鍚庣 emit 鍓嶄粠 memo index 璇诲嚭褰撳墠 memo,
        /// 附在 payload 里一起发给前�?��前�?�� id 决定�?update (已在 memos 里替�?
        /// 还是 insert (不在 memos �?push), 不需�?readMemo IPC, 也不�?path 对比
        /// filename 分流�?
        memo: Memo,
        #[serde(rename = "derivedChanged")]
        derived_changed: MemoDerivedChanged,
        source: MemoChangeSource,
    },
    /// 笔�?�?���?(用户删除 / `clear_memos` / 外部工具 rm 文件)
    Deleted {
        id: String,
        path: String,
        #[serde(rename = "notebookId")]
        notebook_id: String,
        #[serde(rename = "derivedChanged")]
        derived_changed: MemoDerivedChanged,
        source: MemoChangeSource,
    },
    /// 整棵 tag 子树重命名完成 (move_memo_tag IPC): 一次性发出, 替代
    /// 之前每个 affected memo 都发一次 Updated 的方案。后端已经批量改写
    /// 了所有受影响 memo 的 .md body + 同步了 memo index, 这里告诉前端:
    /// - 哪些路径被重命名 ([old, new], 可能多个 — move 整棵子树时一并改)
    /// - 哪些 memo 的 tags 字段需要被前端局部 patch (affected_memo_ids)
    ///
    /// 跟 Updated 区别: 这是 metadata 操作, 不是单条 memo 写入。前端不
    /// 需要把 memo 整体替换 (body/preview/todos 都未变, 只有 tags 数组
    /// 被重写); 也不需要 triggerRefresh — selectedTagId 跟着 newPrefix
    /// 后由 note-navigation-panel 自己 rebase, useEffect [activeTagId]
    /// 自动触发 loadMemos。
    TagsRenamed {
        #[serde(rename = "notebookId")]
        notebook_id: String,
        /// 全层名映射: [(oldFullPath, newFullPath), ...]。 前端用此重写
        /// memos[*].tags 里的 token (前缀替换, 含自身 / 后代)。
        /// 注意: 这里用 tuple 而非 `[String; 2]`, 跟
        /// `flowix_core::MoveTagReport::renamed_tags` 类型保持一致
        /// (直接 `.clone()` 进 payload, 不需要转换)。
        #[serde(rename = "renamedTags")]
        renamed_tags: Vec<(String, String)>,
        /// 受影响的 memo id 列表 — 前端用此定位要 patch 的行。后端
        /// `try_index_upsert` 也基于此逐条刷新搜索索引。
        #[serde(rename = "affectedMemoIds")]
        affected_memo_ids: Vec<String>,
    },
    /// 整棵 tag 子树删除完成 (delete_memo_tag IPC): 一次性发出, 替代
    /// 之前每个 affected memo 都发一次 Updated 的方案。后端已经从
    /// memo_tags + memo index 移除所有相关条目, 也从 .md body 里清理了
    /// `#tag` token, 这里告诉前端:
    /// - 哪些 tag 路径被删除 (deleted_tags, 含 tag_path 自身 + 子树)
    /// - 哪些 memo 的 tags 字段需要被前端局部清理 (affected_memo_ids)
    ///
    /// 跟 TagsRenamed 是对称的姊妹事件, 但语义不同: rename 是改写 token,
    /// delete 是移除 token。 前端 dispatch 路径用同一套 memo.ids 收窄,
    /// 但处理逻辑不同 (rename → rebase, delete → filter out)。
    TagsDeleted {
        #[serde(rename = "notebookId")]
        notebook_id: String,
        /// 被删除的 tag 路径列表 (去重), 含 `tag_path` 自身 + 所有以
        /// `tag_path/` 为前缀的子树 tag。 前端 memos[*].tags 过滤这些值。
        #[serde(rename = "deletedTags")]
        deleted_tags: Vec<String>,
        /// 受影响的 memo id 列表 ── 前端按 id 局部过滤 memos 数组的
        /// .tags, 不替换整个 memo。 后端 `try_index_upsert` 也基于此
        /// 逐条刷新搜索索引 (虽然 tag 删了, 但 memo body 内容变了)。
        #[serde(rename = "affectedMemoIds")]
        affected_memo_ids: Vec<String>,
    },
}

impl MemoEvent {
    /// 事件关联�?memo id。Deleted 总是�?id; Created �?memo 里拿; Updated
    /// 直接读字段。没�?id (例�? unregister_memo_by_path 后的 Deleted) 返回
    /// 当前�?��业务逻辑�?���?���? 保留作内部接口�?
    pub(crate) fn memo_id(&self) -> &str {
        match self {
            MemoEvent::Created { memo, .. } => &memo.id,
            MemoEvent::Updated { id, .. } => id,
            MemoEvent::Deleted { id, .. } => id,
            // TagsRenamed / TagsDeleted 不是单条 memo 事件; 调用方按
            // affected_memo_ids 自行处理。 这里返回空串兜底 (不参与
            // memo-event dedup 的 key)。
            MemoEvent::TagsRenamed { .. } => "",
            MemoEvent::TagsDeleted { .. } => "",
        }
    }
}

/// 触发 emit 的薄包�?。失败不 panic (let _ = 吞掉 emit 错�?, �?`agent-chunk`
/// �?emit 风格保持一�?—IPC 通道关闭时不该�?业务逻辑�?�?///
/// v3 改造后物理 rename 不再发生, 不再需�?id 二级兜底�?
pub fn emit(app: &AppHandle, event: MemoEvent) {
    let _ = emit_with_commit(app, event);
}

pub fn emit_with_commit(app: &AppHandle, event: MemoEvent) -> Option<DocumentCommit> {
    emit_with_commit_from_window(app, event, None)
}

pub fn emit_with_commit_from_window(
    app: &AppHandle,
    event: MemoEvent,
    origin_window_label: Option<&str>,
) -> Option<DocumentCommit> {
    let commit = match commit_for_event(app, &event) {
        Ok(commit) => commit,
        Err(()) => {
            let payload = MemoEventPayload {
                event: &event,
                commit: None,
                origin_window_label,
                derived_only: true,
            };
            if let Some(dispatcher) = app.try_state::<crate::events::SharedDispatcher>() {
                if let Ok(payload) = serde_json::to_value(payload) {
                    dispatcher.publish(MEMO_EVENT, payload);
                }
            } else {
                let _ = app.emit(MEMO_EVENT, payload);
            }
            return None;
        }
    };
    emit_with_recorded_commit_from_window(app, event, commit, origin_window_label)
}

pub(crate) fn emit_with_recorded_commit_from_window(
    app: &AppHandle,
    event: MemoEvent,
    commit: Option<DocumentCommit>,
    origin_window_label: Option<&str>,
) -> Option<DocumentCommit> {
    let sync_change = match &event {
        MemoEvent::Created {
            memo,
            notebook_id,
            source,
            ..
        } if !matches!(source, MemoChangeSource::CloudSync) => Some((
            notebook_id.clone(),
            memo.id.clone(),
            flowix_sync::LocalChangeKind::Put,
        )),
        MemoEvent::Updated {
            id,
            notebook_id,
            source,
            ..
        } if !matches!(source, MemoChangeSource::CloudSync) => Some((
            notebook_id.clone(),
            id.clone(),
            flowix_sync::LocalChangeKind::Put,
        )),
        MemoEvent::Deleted {
            id,
            notebook_id,
            source,
            ..
        } if !matches!(source, MemoChangeSource::CloudSync) => Some((
            notebook_id.clone(),
            id.clone(),
            flowix_sync::LocalChangeKind::Delete,
        )),
        _ => None,
    };
    // 优先�?dispatcher (SharedDispatcher) 抽象, 拿不到退到直�?app.emit�?    // dispatcher �?lib.rs::run �?manage, 为未来�? channel (attachment /
    // tag / notebook) 提供统一入口。本函数�?��务唯一调用�? �?    // 需要动 agent.rs / commands/* 一行代码�?
    if let Some(dispatcher) = app.try_state::<crate::events::SharedDispatcher>() {
        emit_committed_via_dispatcher(&dispatcher, &event, commit.as_ref(), origin_window_label);
    } else {
        let _ = app.emit(
            MEMO_EVENT,
            MemoEventPayload {
                derived_only: false,
                event: &event,
                commit: commit.as_ref(),
                origin_window_label,
            },
        );
    }
    if let Some((notebook_id, note_id, operation)) = sync_change {
        if let Some(state) = app.try_state::<crate::app::state::AppState>() {
            let fingerprint = commit
                .as_ref()
                .map(|commit| commit.content_hash.as_str())
                .unwrap_or_else(|| match operation {
                    flowix_sync::LocalChangeKind::Delete => "deleted",
                    flowix_sync::LocalChangeKind::Put => "unobserved",
                });
            match state.cloud_sync.record_v2_local_change(
                &notebook_id,
                &note_id,
                operation,
                fingerprint,
            ) {
                Ok(generation_changed) => {
                    crate::commands::cloud::schedule_notebook_sync_observation(
                        app.clone(),
                        notebook_id.clone(),
                        generation_changed,
                    );
                }
                Err(error) => tracing::warn!(
                    "failed to persist cloud v2 dirty entity for {notebook_id}/{note_id}: {error}"
                ),
            }
        }
    }
    commit
}

#[derive(Serialize, Clone)]
struct MemoEventPayload<'a> {
    #[serde(rename = "derivedOnly", skip_serializing_if = "is_false")]
    derived_only: bool,
    #[serde(flatten)]
    event: &'a MemoEvent,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    commit: Option<&'a DocumentCommit>,
    #[serde(rename = "originWindowLabel", skip_serializing_if = "Option::is_none")]
    origin_window_label: Option<&'a str>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn commit_for_event(app: &AppHandle, event: &MemoEvent) -> Result<Option<DocumentCommit>, ()> {
    let (memo_id, notebook_id, path) = match event {
        MemoEvent::Created {
            memo, notebook_id, ..
        } => {
            let state = app.try_state::<crate::app::state::AppState>().ok_or(())?;
            let resolved = flowix_core::MemoService::new(&read_lock(&state.memo_file, "memo_file"))
                .resolve_memo(&memo.id)
                .map_err(|_| ())?;
            (memo.id.as_str(), notebook_id.as_str(), resolved.path)
        }
        MemoEvent::Updated {
            id,
            notebook_id,
            path,
            ..
        } if !path.is_empty() => (
            id.as_str(),
            notebook_id.as_str(),
            std::path::PathBuf::from(path),
        ),
        MemoEvent::Deleted {
            id, notebook_id, ..
        } => {
            return DocumentMutationCoordinator::commit_deletion(app, id, notebook_id);
        }
        _ => return Ok(None),
    };
    DocumentMutationCoordinator::commit(app, memo_id, notebook_id, &path)
}

/// 通过 dispatcher 派发 —�?`crate::events::EventDispatcher`
/// 抽象�?`emit()` 默�?优先走这�?(�?`app.state` �?dispatcher 实例),
/// 拿不到才退�?`app.emit` 直接发�?�?channel 扩展 (attachment-event /
/// tag-event) �?dispatcher 里�?�? 业务调用点仍�?`emit()`�?///

#[allow(dead_code)]
pub fn emit_via_dispatcher(dispatcher: &crate::events::SharedDispatcher, event: MemoEvent) {
    emit_committed_via_dispatcher(dispatcher, &event, None, None);
}

fn emit_committed_via_dispatcher(
    dispatcher: &crate::events::SharedDispatcher,
    event: &MemoEvent,
    commit: Option<&DocumentCommit>,
    origin_window_label: Option<&str>,
) {
    let _ = event.memo_id();
    let payload = serde_json::to_value(MemoEventPayload {
        derived_only: false,
        event,
        commit,
        origin_window_label,
    })
    .expect("MemoEvent serialization must not fail");
    dispatcher.publish(MEMO_EVENT, payload);
}

#[cfg(test)]
mod tests {
    //! serde wire-format 测试 —保证与前�?TypeScript 镜像 (app/flowix-web/types/memo.ts)
    //! 的硬契约。`kind` 必须�?snake_case, 字�?命名 (memo/id/path/source) �?    //! �?IPC 边界的硬约定, 不�?随便改�?
    use super::*;
    use flowix_core::memo_file::Memo;

    fn sample_memo() -> Memo {
        Memo {
            id: "abc123".to_string(),
            filename: "Sample.md".to_string(),
            relative_path: "Sample.md".to_string(),
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
        // memo 字�?保持 camelCase (Memo struct �?���?#[serde(rename = "createdAt")] �?
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
    fn committed_event_flattens_revision_contract_in_camel_case() {
        let event = MemoEvent::Updated {
            id: "m_abc".to_string(),
            path: "/tmp/foo.md".to_string(),
            notebook_id: "nb_default".to_string(),
            memo: sample_memo(),
            derived_changed: MemoDerivedChanged::default(),
            source: MemoChangeSource::ExternalTool,
        };
        let commit = DocumentCommit {
            content_hash: "abc123".to_string(),
            revision: 7,
            change_id: "change-7".to_string(),
        };
        let value = serde_json::to_value(MemoEventPayload {
            derived_only: false,
            event: &event,
            commit: Some(&commit),
            origin_window_label: Some("tab-host-abc"),
        })
        .unwrap();

        assert_eq!(value["contentHash"], "abc123");
        assert!(value.get("derivedOnly").is_none());
        let superseded = serde_json::to_value(MemoEventPayload {
            event: &event,
            commit: None,
            origin_window_label: None,
            derived_only: true,
        })
        .unwrap();
        assert_eq!(superseded["derivedOnly"], true);
        assert!(superseded.get("revision").is_none());
        assert_eq!(value["revision"], 7);
        assert_eq!(value["changeId"], "change-7");
        assert_eq!(value["originWindowLabel"], "tab-host-abc");
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
            source: MemoChangeSource::UserDelete,
        };
        let v: serde_json::Value = serde_json::to_value(&event).unwrap();
        assert_eq!(v["kind"], "deleted");
        assert_eq!(v["id"], "m_abc");
        assert_eq!(v["path"], "/tmp/foo.md");
        assert_eq!(v["notebookId"], "nb_default");
        assert_eq!(v["derivedChanged"]["todos"], true);
        assert_eq!(v["source"], "user_delete");
    }

    #[test]
    fn all_sources_have_snake_case_strings() {
        // 防�?日后加新 source 时漏�?rename_all 导致 IPC 失配
        for (variant, expected) in [
            (MemoChangeSource::UserNew, "user_new"),
            (MemoChangeSource::UserImport, "user_import"),
            (MemoChangeSource::UserEdit, "user_edit"),
            (MemoChangeSource::UserDelete, "user_delete"),
            (MemoChangeSource::ExternalTool, "external_tool"),
            (MemoChangeSource::CloudSync, "cloud_sync"),
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

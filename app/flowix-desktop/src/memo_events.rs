//! 缁熶竴绗旇浜嬩欢鎬荤嚎 鈥?鎵€鏈?鍐欒€? (鐢ㄦ埛 UI / Agent / 澶栭儴宸ュ叿) 鍦ㄦ敼瀹岀鐩樺悗
//! 閮?emit 杩欎竴涓簨浠? 鍓嶇涓€涓?`listen()` 娲惧彂鍒?store + 缂栬緫鍣ㄣ€?//!
//! 璁捐瑕佺偣:
//! - 鍗曚竴浜嬩欢鍚?`MEMO_EVENT`, `#[serde(tag = "kind")]` 鍐呴儴鍖哄垎 `created` /
//!   `updated` / `deleted`銆傚鐢?[`crate::agent_flowix::AgentChunk`] 鐨勫垽鍒紡 enum 妯″紡銆?//! - `MemoChangeSource` 鍖哄垎澶栭儴宸ュ叿涓庡簲鐢ㄥ唴鍐欏叆銆傜紪杈戝櫒姝ｆ枃璺ㄧ獥鍙ｅ悓姝ヨ蛋
//!   鐙珛鐨?`MEMO_CONTENT_UPDATED_EVENT`, 閬垮厤閫氱敤鍏冩暟鎹簨浠舵壙鎷呯獥鍙ｆ潵婧愬垽瀹氥€?//! - 鏃т簨浠?`agent-document-updated` 鐢?[`crate::agent_flowix`] 鐨?`edit` 宸ュ叿瑙﹀彂,
//!   鏈閲嶆瀯搴熷純, 鏀圭敱鏈ā鍧楃殑 `Updated` 鍙樹綋鎵胯浇銆?
use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager};

use flowix_core::memo_file::Memo;

pub const MEMO_EVENT: &str = "memo-event";
pub const MEMO_CONTENT_UPDATED_EVENT: &str = "memo-content-updated";

/// 鍐欒€呮爣璇?鈥?浠?informational, 鍓嶇涓嶇敤浜庡垎鏀矾鐢便€?///
/// Plan B 鍚?Agent 涓嶅啀鎵嬪姩 emit, watcher 鎶?Agent / 澶栭儴宸ュ叿鐨勭鐩?/// 鍙樻洿缁熶竴褰掑埌 `ExternalTool`銆俙AgentEdit` / `AgentWrite` 杩欎袱涓彉浣?/// 宸插垹闄?(鍘嗗彶 comment 鎻愬埌銆屽墠绔笉鐢ㄥ畠鍒嗘敮銆? 鍚堝苟鍚庤涔変竴鑷?銆?
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum MemoChangeSource {
    /// 鐢ㄦ埛鐐?"+" 鏂板缓绌虹瑪璁?
    UserNew,
    /// "Save to Memo" 鎸夐挳瀵煎叆澶栭儴鏂囦欢
    UserImport,
    /// 鐢ㄦ埛鍦ㄧ紪杈戝櫒淇濆瓨, 璧?`update_memo_db` / `write_document`
    UserEdit,
    /// 澶栭儴缂栬緫鍣?/ 鍏朵粬 AI / Agent 鏀圭鐩? 鏂囦欢鐩戝惉鍣ㄨ瀵熷埌 鈹€鈹€
    /// v3 鍚庢墍鏈夐潪鐢ㄦ埛涓诲姩淇濆瓨鐨勮矾寰勯兘鍚堝埌杩欓噷
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

/// 绗旇浜嬩欢銆傚墠绔?`useMemoEvents` 鏀跺埌鍚庢寜 `kind` 娲惧彂鍒?store action銆?
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MemoEvent {
    /// 鏂扮瑪璁拌惤鐩?(鏂板缓 / 鎷栨嫿 / 绮樿创 / import / Agent write 鏂版枃浠?
    Created {
        memo: Memo,
        #[serde(rename = "notebookId")]
        notebook_id: String,
        #[serde(rename = "derivedChanged")]
        derived_changed: MemoDerivedChanged,
        source: MemoChangeSource,
    },
    /// 鐜版湁绗旇鐨?preview / tags / todos / `updatedAt` 鍙樺寲 (鐢ㄦ埛缂栬緫 /
    /// Agent edit / 澶栭儴宸ュ叿鏀圭鐩?/ 鏀惰棌鐘舵€佸彉鍖?銆俙path` 鐢ㄤ簬鍓嶇缂栬緫鍣?
    /// path 鍖归厤銆?
    Updated {
        id: String,
        path: String,
        #[serde(rename = "notebookId")]
        notebook_id: String,
        /// v2 rename / update: 鍚庣 emit 鍓嶄粠 memo index 璇诲嚭褰撳墠 memo,
        /// 闄勫湪 payload 閲屼竴璧峰彂缁欏墠绔€傚墠绔寜 id 鍐冲畾鏄?update (宸插湪 memos 閲屾浛鎹?
        /// 杩樻槸 insert (涓嶅湪 memos 閲?push), 涓嶉渶瑕?readMemo IPC, 涔熶笉鐢?path 瀵规瘮
        /// filename 鍒嗘祦銆?
        memo: Memo,
        #[serde(rename = "derivedChanged")]
        derived_changed: MemoDerivedChanged,
        source: MemoChangeSource,
    },
    /// 绗旇琚垹闄?(鐢ㄦ埛鍒犻櫎 / `clear_memos` / 澶栭儴宸ュ叿 rm 鏂囦欢)
    Deleted {
        id: String,
        path: String,
        #[serde(rename = "notebookId")]
        notebook_id: String,
        #[serde(rename = "derivedChanged")]
        derived_changed: MemoDerivedChanged,
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

#[derive(Serialize, Clone, Debug)]
pub struct MemoContentUpdated {
    pub id: String,
    pub path: String,
}

fn is_sibling_window_target(target: &EventTarget, origin_window_label: &str) -> bool {
    match target {
        EventTarget::Window { label }
        | EventTarget::Webview { label }
        | EventTarget::WebviewWindow { label } => label != origin_window_label,
        _ => false,
    }
}

/// Notify every sibling Webview that an editor save has committed to disk.
/// The originating window already owns the saved buffer and must not reload it.
pub fn emit_content_updated_to_sibling_windows<R: tauri::Runtime>(
    app: &AppHandle<R>,
    origin_window_label: &str,
    id: &str,
    path: &str,
) {
    let payload = MemoContentUpdated {
        id: id.to_string(),
        path: path.to_string(),
    };
    let _ = app.emit_filter(MEMO_CONTENT_UPDATED_EVENT, payload, |target| {
        is_sibling_window_target(target, origin_window_label)
    });
}

impl MemoEvent {
    /// 浜嬩欢鍏宠仈鐨?memo id銆侱eleted 鎬绘槸鏈?id; Created 浠?memo 閲屾嬁; Updated
    /// 鐩存帴璇诲瓧娈点€傛病鏈?id (渚嬪 unregister_memo_by_path 鍚庣殑 Deleted) 杩斿洖
    /// 褰撳墠鏈湪涓氬姟閫昏緫涓垎鏀娇鐢? 淇濈暀浣滃唴閮ㄦ帴鍙ｃ€?
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

/// 瑙﹀彂 emit 鐨勮杽鍖呰銆傚け璐ヤ笉 panic (let _ = 鍚炴帀 emit 閿欒, 璺?`agent-chunk`
/// 鐨?emit 椋庢牸淇濇寔涓€鑷?鈥?IPC 閫氶亾鍏抽棴鏃朵笉璇ヨ涓氬姟閫昏緫宕?銆?///
/// v3 鏀归€犲悗鐗╃悊 rename 涓嶅啀鍙戠敓, 涓嶅啀闇€瑕?id 浜岀骇鍏滃簳銆?
pub fn emit(app: &AppHandle, event: MemoEvent) {
    // 浼樺厛璧?dispatcher (SharedDispatcher) 鎶借薄, 鎷夸笉鍒伴€€鍒扮洿鎺?app.emit銆?    // dispatcher 鍦?lib.rs::run 閲?manage, 涓烘湭鏉ュ channel (attachment /
    // tag / notebook) 鎻愪緵缁熶竴鍏ュ彛銆傛湰鍑芥暟鏄笟鍔″敮涓€璋冪敤鐐? 涓?    // 闇€瑕佸姩 agent.rs / commands/* 涓€琛屼唬鐮併€?
    if let Some(dispatcher) = app.try_state::<crate::events::SharedDispatcher>() {
        emit_via_dispatcher(&dispatcher, event);
    } else {
        let _ = app.emit(MEMO_EVENT, &event);
    }
}

/// 閫氳繃 dispatcher 娲惧彂 鈥?璧?`crate::events::EventDispatcher`
/// 鎶借薄銆?`emit()` 榛樿浼樺厛璧拌繖閲?(浠?`app.state` 鎷?dispatcher 瀹炰緥),
/// 鎷夸笉鍒版墠閫€鍒?`app.emit` 鐩存帴鍙戙€?澶?channel 鎵╁睍 (attachment-event /
/// tag-event) 鍦?dispatcher 閲屽鍔? 涓氬姟璋冪敤鐐逛粛璧?`emit()`銆?///

pub fn emit_via_dispatcher(dispatcher: &crate::events::SharedDispatcher, event: MemoEvent) {
    let _ = event.memo_id();
    let payload = serde_json::to_value(&event).expect("MemoEvent serialization must not fail");
    dispatcher.publish(MEMO_EVENT, payload);
}

#[cfg(test)]
mod tests {
    //! serde wire-format 娴嬭瘯 鈥?淇濊瘉涓庡墠绔?TypeScript 闀滃儚 (app/flowix-web/types/memo.ts)
    //! 鐨勭‖濂戠害銆俙kind` 蹇呴』鏄?snake_case, 瀛楁鍛藉悕 (memo/id/path/source) 鏄?    //! 璺?IPC 杈圭晫鐨勭‖绾﹀畾, 涓嶈闅忎究鏀广€?
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
        // memo 瀛楁淇濇寔 camelCase (Memo struct 鑷韩鐢?#[serde(rename = "createdAt")] 绛?
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
    fn content_update_targets_only_sibling_windows() {
        assert!(!is_sibling_window_target(
            &EventTarget::window("tab-host-abc"),
            "tab-host-abc",
        ));
        assert!(is_sibling_window_target(
            &EventTarget::window("main"),
            "tab-host-abc",
        ));
        assert!(!is_sibling_window_target(
            &EventTarget::any(),
            "tab-host-abc",
        ));
    }

    #[test]
    fn content_update_reaches_the_other_webview_window_only() {
        use std::sync::mpsc::channel;
        use std::time::Duration;
        use tauri::{Listener, WebviewWindowBuilder};

        let app = tauri::test::mock_app();
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let tab_host = WebviewWindowBuilder::new(&app, "tab-host-abc", Default::default())
            .build()
            .unwrap();
        let (tx, rx) = channel();

        for (label, window) in [("main", &main), ("tab-host-abc", &tab_host)] {
            let tx = tx.clone();
            window.listen(MEMO_CONTENT_UPDATED_EVENT, move |event| {
                let payload: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
                tx.send((label, payload)).unwrap();
            });
        }

        emit_content_updated_to_sibling_windows(
            app.handle(),
            tab_host.label(),
            "memo-1",
            "/notes/memo-1.md",
        );

        let (recipient, payload) = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(recipient, "main");
        assert_eq!(payload["id"], "memo-1");
        assert_eq!(payload["path"], "/notes/memo-1.md");
        assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());

        emit_content_updated_to_sibling_windows(
            app.handle(),
            main.label(),
            "memo-1",
            "/notes/memo-1-renamed.md",
        );

        let (recipient, payload) = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(recipient, "tab-host-abc");
        assert_eq!(payload["id"], "memo-1");
        assert_eq!(payload["path"], "/notes/memo-1-renamed.md");
        assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());
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
        // 闃叉鏃ュ悗鍔犳柊 source 鏃舵紡鎺?rename_all 瀵艰嚧 IPC 澶遍厤
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

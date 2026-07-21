//! Thread IPC 鈥?瀵硅瘽绾跨▼ CRUD銆?//!
//! `thread_delete` 椤哄甫娓?`AgentManager` 鐨?in-memory 鐘舵€?(涓庤 thread 鍏宠仈鐨?//! read 宸ュ叿蹇収 + 鍗℃妫€娴嬭鏁?, 鍚﹀垯浼氭棤闄愭硠闇层€?
use serde::Serialize;
use tauri::State;

use crate::agent_flowix::default_agent_id;
use crate::agent_session::{
    AgentConversationInstance, ChatMessage, ThreadInfo, ThreadMessagesPage,
    UpsertAgentConversationInstance,
};

use crate::app::state::AppState;

#[derive(Serialize)]
pub struct GetThreadResponse {
    pub messages: Vec<ChatMessage>,
}

#[tauri::command]
pub async fn thread_list(state: State<'_, AppState>) -> Result<Vec<ThreadInfo>, String> {
    let manager = state.thread_manager.read().await;
    manager.list_threads().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn local_agent_thread_list(
    agent_type: String,
    state: State<'_, AppState>,
) -> Result<Vec<ThreadInfo>, String> {
    let agent_type = agent_type.trim().to_ascii_lowercase();
    if !matches!(agent_type.as_str(), "gemini" | "hermes" | "openclaw") {
        return Err(format!("unsupported local agent type: {agent_type}"));
    }

    let manager = state.thread_manager.read().await;
    manager
        .list_threads_by_agent(&agent_type)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn thread_create(
    title: String,
    state: State<'_, AppState>,
) -> Result<ThreadInfo, String> {
    let manager = state.thread_manager.read().await;
    // 鎵€鏈?thread 閮界敤 default_agent_id() 鍗犱綅 鈹€鈹€ 瑙?agent.rs銆?
    manager
        .create_thread(default_agent_id(), title)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn thread_get(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<GetThreadResponse, String> {
    let manager = state.thread_manager.read().await;
    match manager
        .get_thread(&thread_id)
        .await
        .map_err(|e| e.to_string())?
    {
        Some(thread) => Ok(GetThreadResponse {
            messages: thread.messages,
        }),
        None => Err("Thread not found".to_string()),
    }
}

/// Layer 4: 鍒嗛〉鍔犺浇 thread 鍘嗗彶. 鍙栦唬 thread_get 鍦?1MB 绾?thread 涓婄殑鍏ㄩ噺
/// 搴忓垪鍖栧紑閿€, IPC payload 浠?~1MB 闄嶅埌 ~100KB (100 鏉?脳 骞冲潎 1KB).
///
/// 鍙傛暟:
///   - thread_id: 鐩爣 thread
///   - before_sequence: None 鈫?鍙栨渶杩?limit 鏉? Some(s) 鈫?鍙?sequence < s 鐨勬渶杩?limit 鏉?///   - limit: 鍗曟杩斿洖涓婇檺, 鏈嶅姟绔?clamp 鍒?[1, 1000], 榛樿寤鸿鍓嶇浼?100
///
/// 杩斿洖 ThreadMessagesPage { messages (ASC), oldest_sequence, has_more }
/// 鍓嶇鐢?oldest_sequence 浣滀负涓嬩竴椤?cursor, has_more 鍐冲畾椤堕儴 prefetch.
///
/// thread_get 淇濈暀 鈹€鈹€ 璋冭瘯 / 鍏ㄩ噺瀵煎嚭璺緞浠嶅彲鑳界敤鍒般€?
#[tauri::command]
pub async fn thread_get_page(
    thread_id: String,
    before_sequence: Option<i64>,
    limit: i64,
    state: State<'_, AppState>,
) -> Result<ThreadMessagesPage, String> {
    let manager = state.thread_manager.read().await;
    manager
        .get_thread_messages_page(&thread_id, before_sequence, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_list(
    state: State<'_, AppState>,
) -> Result<Vec<AgentConversationInstance>, String> {
    let manager = state.thread_manager.read().await;
    manager
        .list_agent_conversation_instances()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_get(
    instance_id: String,
    state: State<'_, AppState>,
) -> Result<Option<AgentConversationInstance>, String> {
    let manager = state.thread_manager.read().await;
    manager
        .get_agent_conversation_instance(&instance_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_find_by_thread(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Option<AgentConversationInstance>, String> {
    let manager = state.thread_manager.read().await;
    manager
        .find_agent_conversation_by_thread_id(&thread_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_upsert(
    instance: UpsertAgentConversationInstance,
    state: State<'_, AppState>,
) -> Result<AgentConversationInstance, String> {
    let manager = state.thread_manager.read().await;
    manager
        .upsert_agent_conversation_instance(instance)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_delete(
    instance_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let manager = state.thread_manager.read().await;
    manager
        .delete_agent_conversation_instance(&instance_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_delete_for_thread(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let manager = state.thread_manager.read().await;
    manager
        .delete_agent_conversation_instances_for_thread(&thread_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn codex_thread_list(state: State<'_, AppState>) -> Result<Vec<ThreadInfo>, String> {
    let manager = state.thread_manager.read().await;
    manager
        .list_external_threads("codex")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn codex_thread_get(thread_id: String) -> Result<GetThreadResponse, String> {
    let messages = crate::agent_external::codex::get_session(&thread_id).await?;
    Ok(GetThreadResponse { messages })
}

#[tauri::command]
pub async fn codex_thread_get_page(
    thread_id: String,
    before_sequence: Option<i64>,
    limit: i64,
) -> Result<ThreadMessagesPage, String> {
    crate::agent_external::codex::get_session_page(&thread_id, before_sequence, limit).await
}

#[tauri::command]
pub async fn codex_thread_session_id(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    if crate::agent_external::codex::is_codex_session_id(&thread_id) {
        return Ok(Some(thread_id));
    }

    let manager = state.thread_manager.read().await;
    manager
        .get_external_session(&thread_id, "codex")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn claude_thread_list(state: State<'_, AppState>) -> Result<Vec<ThreadInfo>, String> {
    let manager = state.thread_manager.read().await;
    manager
        .list_external_threads("claude")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn claude_thread_get(thread_id: String) -> Result<GetThreadResponse, String> {
    let messages = crate::agent_external::claude::get_session(&thread_id).await?;
    Ok(GetThreadResponse { messages })
}

#[tauri::command]
pub async fn claude_thread_session_id(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    if crate::agent_external::claude::is_claude_session_id(&thread_id) {
        return Ok(Some(thread_id));
    }

    let manager = state.thread_manager.read().await;
    manager
        .get_external_session(&thread_id, "claude")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn hermes_thread_list(state: State<'_, AppState>) -> Result<Vec<ThreadInfo>, String> {
    let manager = state.thread_manager.read().await;
    manager
        .list_external_threads("hermes")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn hermes_thread_get(thread_id: String) -> Result<GetThreadResponse, String> {
    let messages = crate::agent_external::hermes::get_session(&thread_id).await?;
    Ok(GetThreadResponse { messages })
}

#[tauri::command]
pub async fn hermes_thread_get_page(
    thread_id: String,
    before_sequence: Option<i64>,
    limit: i64,
) -> Result<ThreadMessagesPage, String> {
    crate::agent_external::hermes::get_session_page(&thread_id, before_sequence, limit).await
}

#[tauri::command]
pub async fn hermes_thread_session_id(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    if crate::agent_external::hermes::is_hermes_session_id(&thread_id) {
        return Ok(Some(thread_id));
    }

    let manager = state.thread_manager.read().await;
    manager
        .get_external_session(&thread_id, "hermes")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn thread_delete(
    thread_id: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<bool, String> {
    let flowix_stopped = state.agent_manager.stop_chat(&thread_id, None).await;
    let codex_stopped = state
        .codex_cli_manager
        .stop_chat(&thread_id, None, &app_handle)
        .await;
    let claude_stopped = state
        .claude_cli_manager
        .stop_chat(&thread_id, None, &app_handle)
        .await;
    let gemini_stopped = state
        .gemini_cli_manager
        .stop_chat(&thread_id, None, &app_handle)
        .await;
    let hermes_stopped = state
        .hermes_cli_manager
        .stop_chat(&thread_id, None, &app_handle)
        .await;
    let openclaw_stopped = state
        .openclaw_cli_manager
        .stop_chat(&thread_id, None, &app_handle)
        .await;
    if flowix_stopped
        || codex_stopped
        || claude_stopped
        || gemini_stopped
        || hermes_stopped
        || openclaw_stopped
    {
        tracing::info!("[Thread] stopped running agent before deleting thread {thread_id}");
    }

    // 鍏堟竻 AgentManager 鐨?in-memory 鐘舵€?鈹€鈹€ 涓庤 thread 鍏宠仈鐨?read 宸ュ叿蹇収
    // (HashMap<thread_id, HashMap<path, full_file_content>>, 鏁存湰绗旇鏈ぇ灏?
    // 涓庡崱姝绘娴嬭鏁? 鍚﹀垯浼氭棤闄愭硠闇层€備袱寮犺〃鐙珛 HashMap.remove, 鎬绘槸鎴愬姛銆?    //
    // `agent_manager` 鏄?`Arc<AgentManager>`, `cleanup_thread` 鏄?`&self` 鏂规硶,
    // 鐩存帴璋冪敤鍗冲彲, 涓嶅啀闇€瑕?`.write().await` 鍖呰銆?    state.agent_manager.cleanup_thread(&thread_id).await;
    let manager = state.thread_manager.read().await;
    manager
        .delete_thread_with_agent_conversations(&thread_id)
        .await
        .map_err(|e| e.to_string())
}

/// 閲嶅懡鍚?thread 鈹€鈹€ 鏀?SQLite `threads.title` 鍒? 椤哄甫 bump `updated_at`,
/// 璁╁巻鍙插垪琛ㄦ寜"鏈€杩戞椿鍔?鎺掑簭鏃? 鍒氳鏀瑰悕鐨勫璇濊兘姝ｇ‘椤跺埌椤堕儴銆?///
/// 杩斿洖 `None` 琛ㄧず thread 涓嶅瓨鍦?(UI 搴斿拷鐣?; 杩斿洖 `Some(info)` 鏃?info.title
/// 宸茬粡鏄柊鍊? 鍙洿鎺ョ敤浜庢洿鏂版湰鍦?store銆傚墠绔?`sendMessageStream` 鍦ㄩ鏉＄敤鎴?/// 娑堟伅钀藉湴鍚庤皟涓€娆? 瑕嗙洊"鐐逛簡"鏂板缓瀵硅瘽"鍐嶅彂娑堟伅"鐨勬棭鏈熻矾寰?閭ｇ鎯呭喌涓?/// `ensureThread` 璧?early return, 涓嶄細鐢熸垚鏂版爣棰?銆?
#[tauri::command]
#[allow(non_snake_case)]
pub async fn thread_update_title(
    thread_id: String,
    title: String,
    agentType: Option<String>,
    state: State<'_, AppState>,
) -> Result<Option<ThreadInfo>, String> {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return Err("Thread title cannot be empty".to_string());
    }
    tracing::info!(
        "[Thread] update title requested for thread_id: {}, agent_type: {}",
        thread_id,
        agentType.as_deref().unwrap_or("unknown")
    );
    let agent_id = agentType
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("default");
    let manager = state.thread_manager.read().await;
    manager
        .update_title(
            &thread_id,
            title,
            crate::agent_types::AgentId::new(agent_id),
        )
        .await
        .map_err(|e| e.to_string())
}

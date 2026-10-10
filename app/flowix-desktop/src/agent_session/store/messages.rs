//! Thread message pagination, persistence, and tool/checkpoint updates.

use super::ThreadManager;
use crate::agent_session::error::ThreadError;
use crate::agent_session::types::{ChatMessage, ThreadMessagesPage};
use rusqlite::params;
use std::sync::Arc;

impl ThreadManager {
    pub async fn get_thread_messages_page(
        self: &Arc<Self>,
        thread_id: &str,
        before_sequence: Option<i64>,
        limit: i64,
    ) -> Result<ThreadMessagesPage, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| {
            tm.get_thread_messages_page_inner(&thread_id, before_sequence, limit)
        })
        .await
    }

    fn get_thread_messages_page_inner(
        &self,
        thread_id: &str,
        before_sequence: Option<i64>,
        limit: i64,
    ) -> Result<ThreadMessagesPage, ThreadError> {
        // Clamp defensively to avoid frontend mistakes such as 0 or huge limits.
        let limit = limit.clamp(1, 1000);
        let conn = self.lock_conn();

        // DESC + LIMIT uses the (thread_id, sequence) composite index and avoids OFFSET scans.
        let messages: Vec<(ChatMessage, i64)> = match before_sequence {
            Some(before) => {
                let mut stmt = conn.prepare(
                    "SELECT id, role, content, llm_content, system_reminder_directory, timestamp,
                            is_loading, tool_call_id, tool_name, tool_data, tool_input, tool_calls, reasoning,
                            is_completed, is_collapsed, sequence
                     FROM thread_messages
                     WHERE thread_id = ?1 AND sequence < ?2
                     ORDER BY sequence DESC LIMIT ?3",
                )?;
                let rows = stmt.query_map(
                    params![thread_id, before, limit],
                    Self::row_to_message_with_seq,
                )?;
                rows.collect::<Result<Vec<_>, _>>()?
            }
            None => {
                let mut stmt = conn.prepare(
                    "SELECT id, role, content, llm_content, system_reminder_directory, timestamp,
                            is_loading, tool_call_id, tool_name, tool_data, tool_input, tool_calls, reasoning,
                            is_completed, is_collapsed, sequence
                     FROM thread_messages
                     WHERE thread_id = ?1
                     ORDER BY sequence DESC LIMIT ?2",
                )?;
                let rows =
                    stmt.query_map(params![thread_id, limit], Self::row_to_message_with_seq)?;
                rows.collect::<Result<Vec<_>, _>>()?
            }
        };

        // Reverse back to ASC for the frontend. In DESC order, the last row has the oldest sequence.
        let oldest_sequence = messages.last().map(|(_, seq)| *seq);
        let mut messages_asc: Vec<ChatMessage> = messages.into_iter().map(|(m, _)| m).collect();
        messages_asc.reverse();

        // has_more: check whether rows exist before oldest_sequence. COUNT is index-covered.
        let has_more = if let Some(oldest) = oldest_sequence {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM thread_messages WHERE thread_id = ?1 AND sequence < ?2",
                params![thread_id, oldest],
                |row| row.get(0),
            )?;
            count > 0
        } else {
            false
        };

        Ok(ThreadMessagesPage {
            messages: messages_asc,
            oldest_sequence,
            has_more,
            snapshot_sequence: None,
            complete_turn_ids: None,
        })
    }

    pub async fn add_message(
        self: &Arc<Self>,
        thread_id: &str,
        message: ChatMessage,
    ) -> Result<(), ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| tm.add_message_inner(&thread_id, message))
            .await
    }

    fn add_message_inner(&self, thread_id: &str, message: ChatMessage) -> Result<(), ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.lock_conn();
        let sequence: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM thread_messages WHERE thread_id = ?1",
            [thread_id],
            |row| row.get(0),
        )?;

        conn.execute(
            "INSERT INTO thread_messages (
                id, thread_id, role, content, llm_content, system_reminder_directory, timestamp,
                is_loading, tool_call_id, tool_name, tool_data, tool_input, tool_calls, reasoning,
                is_completed, is_collapsed, sequence
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                message.id,
                thread_id,
                message.role,
                message.content,
                message.llm_content,
                message.system_reminder_directory,
                message.timestamp,
                opt_bool_to_int(message.is_loading),
                message.tool_call_id,
                message.tool_name,
                message.tool_data,
                message.tool_input.map(|v| v.to_string()),
                message.tool_calls.as_ref().map(|v| v.to_string()),
                message.reasoning,
                opt_bool_to_int(message.is_completed),
                opt_bool_to_int(message.is_collapsed),
                sequence,
            ],
        )?;
        self.touch_thread(&conn, thread_id, now)?;
        Ok(())
    }

    pub async fn update_tool_result(
        self: &Arc<Self>,
        thread_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        result_content: &str,
    ) -> Result<(), ThreadError> {
        let thread_id = thread_id.to_string();
        let tool_call_id = tool_call_id.to_string();
        let tool_name = tool_name.to_string();
        let result_content = result_content.to_string();
        self.run_blocking(move |tm| {
            tm.update_tool_result_inner(&thread_id, &tool_call_id, &tool_name, &result_content)
        })
        .await
    }

    fn update_tool_result_inner(
        &self,
        thread_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        result_content: &str,
    ) -> Result<(), ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE thread_messages
             SET content = ?1, tool_data = ?1, tool_name = ?2, is_loading = 0
             WHERE thread_id = ?3 AND role = 'tool' AND tool_call_id = ?4",
            params![result_content, tool_name, thread_id, tool_call_id],
        )?;
        self.touch_thread(&conn, thread_id, now)?;
        Ok(())
    }

    /// Only reset `is_loading = 0`; do not touch `content` / `tool_data` / `tool_name`.
    /// Used by `IsLoadingGuard` on error paths to unlock the UI spinner without
    /// overwriting a partially written tool result or bumping thread metadata.
    pub async fn clear_tool_loading(
        self: &Arc<Self>,
        thread_id: &str,
        tool_call_id: &str,
    ) -> Result<(), ThreadError> {
        let thread_id = thread_id.to_string();
        let tool_call_id = tool_call_id.to_string();
        self.run_blocking(move |tm| tm.clear_tool_loading_inner(&thread_id, &tool_call_id))
            .await
    }

    fn clear_tool_loading_inner(
        &self,
        thread_id: &str,
        tool_call_id: &str,
    ) -> Result<(), ThreadError> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE thread_messages SET is_loading = 0
             WHERE thread_id = ?1 AND role = 'tool' AND tool_call_id = ?2",
            params![thread_id, tool_call_id],
        )?;
        Ok(())
    }

    /// Startup cleanup: reset all `is_loading = 1` rows, regardless of role.
    ///
    /// This handles crashes after a tool_use row was persisted but before its
    /// tool_result arrived. The synchronous version is intentional: startup calls
    /// this before the Tauri runtime is available, and the work is a single SQLite UPDATE.
    /// Returns the affected row count for startup logging.
    pub fn clear_all_loading(&self) -> Result<u64, ThreadError> {
        let conn = self.lock_conn();
        let n = conn.execute(
            "UPDATE thread_messages SET is_loading = 0 WHERE is_loading = 1",
            [],
        )?;
        Ok(n as u64)
    }

    /// Overwrite the `tool_calls` JSON column of an existing message.
    /// Used by the agent's recovery loop to sanitize malformed
    /// `function.arguments` strings in place rather than delete-and-reinsert
    /// (which would disturb the message's `sequence` and confuse the
    /// reload on the next round). Returns true if the row was found and
    /// updated.
    pub async fn update_message_tool_calls(
        self: &Arc<Self>,
        thread_id: &str,
        message_id: &str,
        tool_calls_json: &serde_json::Value,
    ) -> Result<bool, ThreadError> {
        let thread_id = thread_id.to_string();
        let message_id = message_id.to_string();
        let tool_calls_json = tool_calls_json.clone();
        self.run_blocking(move |tm| {
            tm.update_message_tool_calls_inner(&thread_id, &message_id, &tool_calls_json)
        })
        .await
    }

    fn update_message_tool_calls_inner(
        &self,
        thread_id: &str,
        message_id: &str,
        tool_calls_json: &serde_json::Value,
    ) -> Result<bool, ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.lock_conn();
        let updated = conn.execute(
            "UPDATE thread_messages SET tool_calls = ?1
             WHERE thread_id = ?2 AND id = ?3",
            params![tool_calls_json.to_string(), thread_id, message_id],
        )?;
        if updated > 0 {
            self.touch_thread(&conn, thread_id, now)?;
        }
        Ok(updated > 0)
    }

    /// Update an assistant checkpoint in place. External runtimes use this
    /// when a stream is interrupted after some text has already reached the
    /// UI: the partial assistant row is first inserted, then later marked
    /// completed or promoted to an assistant+tool_calls row if the resumed
    /// turn asks for a tool.
    pub async fn update_assistant_checkpoint(
        self: &Arc<Self>,
        thread_id: &str,
        message_id: &str,
        content: &str,
        is_completed: Option<bool>,
        tool_calls_json: Option<&serde_json::Value>,
        reasoning: Option<&str>,
    ) -> Result<bool, ThreadError> {
        let thread_id = thread_id.to_string();
        let message_id = message_id.to_string();
        let content = content.to_string();
        let tool_calls_json = tool_calls_json.cloned();
        let reasoning = reasoning.map(str::to_string);
        self.run_blocking(move |tm| {
            tm.update_assistant_checkpoint_inner(
                &thread_id,
                &message_id,
                &content,
                is_completed,
                tool_calls_json.as_ref(),
                reasoning.as_deref(),
            )
        })
        .await
    }

    fn update_assistant_checkpoint_inner(
        &self,
        thread_id: &str,
        message_id: &str,
        content: &str,
        is_completed: Option<bool>,
        tool_calls_json: Option<&serde_json::Value>,
        reasoning: Option<&str>,
    ) -> Result<bool, ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.lock_conn();
        let updated = if let Some(tool_calls_json) = tool_calls_json {
            conn.execute(
                "UPDATE thread_messages
                 SET content = ?1, is_completed = ?2, tool_calls = ?3, reasoning = COALESCE(?4, reasoning)
                 WHERE thread_id = ?5 AND id = ?6 AND role = 'assistant'",
                params![
                    content,
                    opt_bool_to_int(is_completed),
                    tool_calls_json.to_string(),
                    reasoning,
                    thread_id,
                    message_id,
                ],
            )?
        } else {
            conn.execute(
                "UPDATE thread_messages
                 SET content = ?1, is_completed = ?2, reasoning = COALESCE(?3, reasoning)
                 WHERE thread_id = ?4 AND id = ?5 AND role = 'assistant'",
                params![
                    content,
                    opt_bool_to_int(is_completed),
                    reasoning,
                    thread_id,
                    message_id,
                ],
            )?
        };
        if updated > 0 {
            self.touch_thread(&conn, thread_id, now)?;
        }
        Ok(updated > 0)
    }

    pub(super) fn row_to_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatMessage> {
        let tool_input_raw: Option<String> = row.get(10)?;
        let tool_calls_raw: Option<String> = row.get(11)?;
        Ok(ChatMessage {
            id: row.get(0)?,
            role: row.get(1)?,
            message_type: None,
            content: row.get(2)?,
            attachments: None,
            llm_content: row.get(3)?,
            system_reminder_directory: row.get(4)?,
            timestamp: row.get(5)?,
            is_loading: int_to_opt_bool(row.get(6)?),
            tool_call_id: row.get(7)?,
            tool_name: row.get(8)?,
            tool_data: row.get(9)?,
            tool_input: tool_input_raw.and_then(|raw| serde_json::from_str(&raw).ok()),
            tool_call: None,
            tool_result: None,
            tool_calls: tool_calls_raw.and_then(|raw| serde_json::from_str(&raw).ok()),
            reasoning: row.get(12)?,
            is_completed: int_to_opt_bool(row.get(13)?),
            error_details: None,
            is_collapsed: int_to_opt_bool(row.get(14)?),
            codex_turn_id: None,
            turn_duration_ms: None,
            source_sequence: None,
        })
    }
    fn row_to_message_with_seq(row: &rusqlite::Row<'_>) -> rusqlite::Result<(ChatMessage, i64)> {
        let message = Self::row_to_message(row)?;
        let sequence: i64 = row.get(15)?;
        Ok((message, sequence))
    }
}

fn opt_bool_to_int(value: Option<bool>) -> Option<i64> {
    value.map(|v| if v { 1 } else { 0 })
}

fn int_to_opt_bool(value: Option<i64>) -> Option<bool> {
    value.map(|v| v != 0)
}

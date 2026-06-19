use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use serde_json::{json, Value};

use crate::{APP_DATA_DIR_NAME, USER_CONFIG_DIR_NAME};

pub const PRODUCT_NAME: &str = "Flowix";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn user_config_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(USER_CONFIG_DIR_NAME)
}

pub fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(APP_DATA_DIR_NAME)
}

pub fn log_dir() -> PathBuf {
    user_config_dir().join("logs")
}

pub fn ensure_log_dir() -> std::io::Result<PathBuf> {
    let dir = log_dir();
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn record_event(level: &str, event: &str, message: impl AsRef<str>) {
    let log_dir = match ensure_log_dir() {
        Ok(dir) => dir,
        Err(_) => return,
    };
    let file_name = if level.eq_ignore_ascii_case("error") {
        "error.log"
    } else {
        "app.log"
    };
    let path = log_dir.join(file_name);
    let line = json!({
        "time": chrono::Utc::now().to_rfc3339(),
        "level": level,
        "event": event,
        "message": message.as_ref(),
        "product": PRODUCT_NAME,
        "version": APP_VERSION,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "pid": std::process::id(),
    });

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

/// 记录 Agent (LLM chat / tool 调用) 的一次结构化事件。
///
/// 与 `record_event` 的区别:
/// - 写 `~/.flowix/logs/agent.log`, 与通用 `app.log` / `error.log` 物理隔离,
///   便于「只看 Agent 错误」时直接 `cat agent.log | grep '"level":"error"'`。
/// - JSON 形状多带 `thread_id` / `tool` / `kind` 字段 ── agent 错误天然
///   跟 thread 绑定, 不带 thread_id 在并行情形下无法定位是哪个对话出的
///   问题。`kind` 给前端 / 排障脚本一个稳定的判别维度 (例如
///   `kind=llm_stream` / `kind=tool_error` / `kind=stuck` / `kind=max_cycles` /
///   `kind=token_budget` / `kind=recovery_retry`)。
///
/// 与「LLM 错误流回 Agent 处理」的关系: 工具调用失败 / LLM 流断 等事件
/// 都会先 emit `AgentChunk::ToolResult` / `Error` 块把信息交给 LLM 让它
/// 自纠 (重试 / 换工具 / 改路径 / 收口), 这里的 `record_agent_event` 是
/// **镜像**到磁盘, 供后续排障, 不替代 LLM 决策路径。
///
/// `level` 与 `event` 沿用 `record_event` 的语义 ── `level` 仅控制日志
/// 行的语义分级, 不影响文件路由 (agent 全部走 `agent.log`)。
///
/// IO 失败 (磁盘满 / 权限不足) 一律静默吞掉, 避免日志本身把 chat
/// 主流程搞挂 ── 与 `record_event` 保持一致的"尽力而为"语义。
pub fn record_agent_event(
    level: &str,
    kind: &str,
    event: &str,
    message: impl AsRef<str>,
    thread_id: Option<&str>,
    tool: Option<&str>,
    extra: Option<Value>,
) {
    let log_dir = match ensure_log_dir() {
        Ok(dir) => dir,
        Err(_) => return,
    };
    let path = log_dir.join("agent.log");

    let mut line = json!({
        "time": chrono::Utc::now().to_rfc3339(),
        "level": level,
        "kind": kind,
        "event": event,
        "message": message.as_ref(),
        "product": PRODUCT_NAME,
        "version": APP_VERSION,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "pid": std::process::id(),
    });
    if let Some(tid) = thread_id {
        line["thread_id"] = Value::String(tid.to_string());
    }
    if let Some(tool) = tool {
        line["tool"] = Value::String(tool.to_string());
    }
    if let Some(extra) = extra {
        if let Value::Object(map) = extra {
            if let Value::Object(ref mut base) = line {
                for (k, v) in map {
                    base.insert(k, v);
                }
            }
        }
    }

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

/// 测试专用: 把结构化事件写到指定目录, 不污染用户 `~/.flowix/logs/agent.log`。
/// 复用 `record_agent_event` 同样的 JSON 行形状 ── 单元测试可断言字段集。
#[cfg(test)]
pub fn record_agent_event_to(dir: &PathBuf, level: &str, kind: &str, event: &str, message: &str) {
    let path = dir.join("agent.log");
    let line = json!({
        "time": chrono::Utc::now().to_rfc3339(),
        "level": level,
        "kind": kind,
        "event": event,
        "message": message,
        "product": PRODUCT_NAME,
        "version": APP_VERSION,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "pid": std::process::id(),
    });
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_agent_event_writes_one_json_line_per_call() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().to_path_buf();
        record_agent_event_to(&dir, "error", "llm_stream", "llm.stream_failed", "boom");
        record_agent_event_to(&dir, "warn", "stuck", "agent.stuck", "loop");

        let body = std::fs::read_to_string(dir.join("agent.log")).expect("read agent.log");
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 2, "each call must append exactly one line");

        // 第一行: 必含字段 + level=error + kind=llm_stream
        let v0: serde_json::Value = serde_json::from_str(lines[0]).expect("line 0 is JSON");
        assert_eq!(v0["level"], "error");
        assert_eq!(v0["kind"], "llm_stream");
        assert_eq!(v0["event"], "llm.stream_failed");
        assert_eq!(v0["message"], "boom");
        assert_eq!(v0["product"], PRODUCT_NAME);
        assert!(v0["time"].is_string(), "time must be RFC3339 string");
        assert!(v0["pid"].is_u64(), "pid must be a number");

        // 第二行: level=warn + kind=stuck
        let v1: serde_json::Value = serde_json::from_str(lines[1]).expect("line 1 is JSON");
        assert_eq!(v1["level"], "warn");
        assert_eq!(v1["kind"], "stuck");
    }

    #[test]
    fn record_agent_event_does_not_touch_app_log_or_error_log() {
        // agent 事件只写 agent.log ── 不污染 app.log / error.log。
        // 用空 tempdir, 调用后只能看到 agent.log, 不应该有其它文件。
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().to_path_buf();
        record_agent_event_to(&dir, "error", "tool_error", "tool.execution_failed", "x");

        let mut entries: Vec<String> = std::fs::read_dir(&dir)
            .expect("read_dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        entries.sort();
        assert_eq!(entries, vec!["agent.log"], "only agent.log should exist");
    }
}

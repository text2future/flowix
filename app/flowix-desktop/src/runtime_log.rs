use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde_json::{json, Value};

use crate::{APP_DATA_DIR_NAME, USER_CONFIG_DIR_NAME};

pub const PRODUCT_NAME: &str = "Flowix";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

static LOG_WRITE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

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

    append_json_line(path, &line);
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

    append_json_line(path, &line);
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
    append_json_line(path, &line);
}

fn append_json_line(path: PathBuf, line: &Value) {
    let Ok(_guard) = LOG_WRITE_LOCK.lock() else {
        return;
    };
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

// ---------------------------------------------------------------------------
// dev-only external agent stdout dump (`~/.flowix/debug/`)
// ---------------------------------------------------------------------------

/// dev 环境才启用的 external agent stdout 原始流 dump 目录: `~/.flowix/debug/`。
/// 与 `log_dir()` (`~/.flowix/logs/`) 物理隔离 ── debug 装的是子进程 stdout
/// 原文全量, 体量大且可能含用户笔记内容, 仅 dev 构建写入, release 不触碰。
pub fn debug_dir() -> PathBuf {
    user_config_dir().join("debug")
}

/// 专属于 debug dump 的写入锁, 与 `LOG_WRITE_LOCK` 隔离 ── debug 行数远多于
/// agent.log (单次 claude 运行可逾千行), 独立锁避免拖慢常规日志。
static DEBUG_WRITE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// 仅 dev 构建: 把 external agent (claude / codex) 子进程 stdout 的一行原始
/// JSONL 追加 dump 到 `~/.flowix/debug/<agent>-<run_id>.jsonl`。
///
/// 与 `record_agent_event` (写 `agent.log` 结构化事件摘要) 的区别: 这里写的是
/// 子进程 stdout 原文全量 (含 `thinking_tokens` 增量 / `tool_use` / `tool_result`
/// 原始块), 供排障时 1:1 还原 vendor CLI 真实回包。
///
/// **仅 dev**: `cfg!(debug_assertions)` 门控, release 构建立即返回 ── 不建目录、
/// 不开文件, 生产环境绝不把用户笔记内容 / agent 流数据落盘。IO 失败静默吞掉,
/// 不影响流处理主路径 (与 `record_agent_event` 一致的"尽力而为"语义)。
///
/// `thread_id` 当前不进文件名 (`run_id` 已唯一标识本次运行), 保留参数位是为
/// 后续按对话归档 / 注入 dump header 预留, 也让调用点语义自解释。
pub fn dump_debug_stdout_line(agent_type: &str, _thread_id: &str, run_id: &str, line: &str) {
    if !cfg!(debug_assertions) {
        return;
    }
    dump_debug_stdout_line_to(&debug_dir(), agent_type, run_id, line);
}

/// `dump_debug_stdout_line` 的核心写入逻辑, 接受任意目录 ── 供单测在不污染
/// 用户 `~/.flowix/debug/` 的前提下断言行为。不做 dev 门控 (test 都是 debug
/// profile, 门控恒真)。
fn dump_debug_stdout_line_to(dir: &PathBuf, agent_type: &str, run_id: &str, line: &str) {
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    let file_name = format!(
        "{}-{}.jsonl",
        sanitize_debug_id(agent_type),
        sanitize_debug_id(run_id)
    );
    let path = dir.join(file_name);
    let Ok(_guard) = DEBUG_WRITE_LOCK.lock() else {
        return;
    };
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

/// 把任意字符串收敛成安全的文件名片段: 只保留 `[A-Za-z0-9._-]`, 其余替换为 `_`。
/// `agent_type` / `run_id` 通常已是安全字符, 这里是防御性兜底, 避免路径穿越 / 非法文件名。
fn sanitize_debug_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
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

    #[test]
    fn dump_debug_stdout_line_to_appends_raw_lines() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().to_path_buf();
        dump_debug_stdout_line_to(&dir, "claude", "run-abc", "{\"type\":\"system\",\"subtype\":\"init\"}");
        dump_debug_stdout_line_to(&dir, "claude", "run-abc", "{\"type\":\"assistant\"}");

        // 同一 run 多行 -> 同一文件追加, 每次一行。
        let body = std::fs::read_to_string(dir.join("claude-run-abc.jsonl")).expect("read dump");
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 2, "each call appends exactly one line");
        assert!(lines[0].contains("\"subtype\":\"init\""));
        assert!(lines[1].contains("\"assistant\""));
    }

    #[test]
    fn dump_debug_stdout_line_to_partitions_per_run() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().to_path_buf();
        dump_debug_stdout_line_to(&dir, "claude", "run-1", "a");
        dump_debug_stdout_line_to(&dir, "claude", "run-2", "b");

        // 不同 run_id -> 不同文件, 互不覆盖。
        assert_eq!(
            std::fs::read_to_string(dir.join("claude-run-1.jsonl")).unwrap(),
            "a\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("claude-run-2.jsonl")).unwrap(),
            "b\n"
        );
    }

    #[test]
    fn sanitize_debug_id_keeps_safe_chars_only() {
        assert_eq!(sanitize_debug_id("claude"), "claude");
        assert_eq!(sanitize_debug_id("run-1.2"), "run-1.2");
        // 空格 / 斜杠等非法文件名字符 -> '_', 阻断路径穿越。
        assert_eq!(sanitize_debug_id("a b/c"), "a_b_c");
        assert_eq!(sanitize_debug_id("../etc"), ".._etc");
    }
}

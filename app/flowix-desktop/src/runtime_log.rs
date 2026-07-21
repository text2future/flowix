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

/// 璁板綍 Agent (LLM chat / tool 璋冪敤) 鐨勪竴娆＄粨鏋勫寲浜嬩欢銆?///
/// 涓?`record_event` 鐨勫尯鍒?
/// - 鍐?`~/.flowix/logs/agent.log`, 涓庨€氱敤 `app.log` / `error.log` 鐗╃悊闅旂,
///   渚夸簬銆屽彧鐪?Agent 閿欒銆嶆椂鐩存帴 `cat agent.log | grep '"level":"error"'`銆?/// - JSON 褰㈢姸澶氬甫 `thread_id` / `tool` / `kind` 瀛楁 鈹€鈹€ agent 閿欒澶╃劧
///   璺?thread 缁戝畾, 涓嶅甫 thread_id 鍦ㄥ苟琛屾儏褰笅鏃犳硶瀹氫綅鏄摢涓璇濆嚭鐨?///   闂銆俙kind` 缁欏墠绔?/ 鎺掗殰鑴氭湰涓€涓ǔ瀹氱殑鍒ゅ埆缁村害 (渚嬪
///   `kind=llm_stream` / `kind=tool_error` / `kind=stuck` / `kind=max_cycles` /
///   `kind=token_budget` / `kind=recovery_retry`)銆?///
/// 涓庛€孡LM 閿欒娴佸洖 Agent 澶勭悊銆嶇殑鍏崇郴: 宸ュ叿璋冪敤澶辫触 / LLM 娴佹柇 绛変簨浠?/// 閮戒細鍏?emit `AgentChunk::ToolResult` / `Error` 鍧楁妸淇℃伅浜ょ粰 LLM 璁╁畠
/// 鑷籂 (閲嶈瘯 / 鎹㈠伐鍏?/ 鏀硅矾寰?/ 鏀跺彛), 杩欓噷鐨?`record_agent_event` 鏄?/// **闀滃儚**鍒扮鐩? 渚涘悗缁帓闅? 涓嶆浛浠?LLM 鍐崇瓥璺緞銆?///
/// `level` 涓?`event` 娌跨敤 `record_event` 鐨勮涔?鈹€鈹€ `level` 浠呮帶鍒舵棩蹇?/// 琛岀殑璇箟鍒嗙骇, 涓嶅奖鍝嶆枃浠惰矾鐢?(agent 鍏ㄩ儴璧?`agent.log`)銆?///
/// IO 澶辫触 (纾佺洏婊?/ 鏉冮檺涓嶈冻) 涓€寰嬮潤榛樺悶鎺? 閬垮厤鏃ュ織鏈韩鎶?chat
/// 涓绘祦绋嬫悶鎸?鈹€鈹€ 涓?`record_event` 淇濇寔涓€鑷寸殑"灏藉姏鑰屼负"璇箟銆?
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

/// 娴嬭瘯涓撶敤: 鎶婄粨鏋勫寲浜嬩欢鍐欏埌鎸囧畾鐩綍, 涓嶆薄鏌撶敤鎴?`~/.flowix/logs/agent.log`銆?/// 澶嶇敤 `record_agent_event` 鍚屾牱鐨?JSON 琛屽舰鐘?鈹€鈹€ 鍗曞厓娴嬭瘯鍙柇瑷€瀛楁闆嗐€?
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

/// dev 鐜鎵嶅惎鐢ㄧ殑 external agent stdout 鍘熷娴?dump 鐩綍: `~/.flowix/debug/`銆?/// 涓?`log_dir()` (`~/.flowix/logs/`) 鐗╃悊闅旂 鈹€鈹€ debug 瑁呯殑鏄瓙杩涚▼ stdout
/// 鍘熸枃鍏ㄩ噺, 浣撻噺澶т笖鍙兘鍚敤鎴风瑪璁板唴瀹? 浠?dev 鏋勫缓鍐欏叆, release 涓嶈Е纰般€?
pub fn debug_dir() -> PathBuf {
    user_config_dir().join("debug")
}

/// 涓撳睘浜?debug dump 鐨勫啓鍏ラ攣, 涓?`LOG_WRITE_LOCK` 闅旂 鈹€鈹€ debug 琛屾暟杩滃浜?
/// agent.log (鍗曟 claude 杩愯鍙€惧崈琛?, 鐙珛閿侀伩鍏嶆嫋鎱㈠父瑙勬棩蹇椼€?
static DEBUG_WRITE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// 浠?dev 鏋勫缓: 鎶?external agent (claude / codex) 瀛愯繘绋?stdout 鐨勪竴琛屽師濮?/// JSONL 杩藉姞 dump 鍒?`~/.flowix/debug/<agent>-<run_id>.jsonl`銆?///
/// 涓?`record_agent_event` (鍐?`agent.log` 缁撴瀯鍖栦簨浠舵憳瑕? 鐨勫尯鍒? 杩欓噷鍐欑殑鏄?/// 瀛愯繘绋?stdout 鍘熸枃鍏ㄩ噺 (鍚?`thinking_tokens` 澧為噺 / `tool_use` / `tool_result`
/// 鍘熷鍧?, 渚涙帓闅滄椂 1:1 杩樺師 vendor CLI 鐪熷疄鍥炲寘銆?///
/// **浠?dev**: `cfg!(debug_assertions)` 闂ㄦ帶, release 鏋勫缓绔嬪嵆杩斿洖 鈹€鈹€ 涓嶅缓鐩綍銆?/// 涓嶅紑鏂囦欢, 鐢熶骇鐜缁濅笉鎶婄敤鎴风瑪璁板唴瀹?/ agent 娴佹暟鎹惤鐩樸€侷O 澶辫触闈欓粯鍚炴帀,
/// 涓嶅奖鍝嶆祦澶勭悊涓昏矾寰?(涓?`record_agent_event` 涓€鑷寸殑"灏藉姏鑰屼负"璇箟)銆?///
/// `thread_id` 褰撳墠涓嶈繘鏂囦欢鍚?(`run_id` 宸插敮涓€鏍囪瘑鏈杩愯), 淇濈暀鍙傛暟浣嶆槸涓?/// 鍚庣画鎸夊璇濆綊妗?/ 娉ㄥ叆 dump header 棰勭暀, 涔熻璋冪敤鐐硅涔夎嚜瑙ｉ噴銆?
pub fn dump_debug_stdout_line(agent_type: &str, _thread_id: &str, run_id: &str, line: &str) {
    if !cfg!(debug_assertions) {
        return;
    }
    dump_debug_stdout_line_to(&debug_dir(), agent_type, run_id, line);
}

/// `dump_debug_stdout_line` 鐨勬牳蹇冨啓鍏ラ€昏緫, 鎺ュ彈浠绘剰鐩綍 鈹€鈹€ 渚涘崟娴嬪湪涓嶆薄鏌?/// 鐢ㄦ埛 `~/.flowix/debug/` 鐨勫墠鎻愪笅鏂█琛屼负銆備笉鍋?dev 闂ㄦ帶 (test 閮芥槸 debug
/// profile, 闂ㄦ帶鎭掔湡)銆?
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

/// 鎶婁换鎰忓瓧绗︿覆鏀舵暃鎴愬畨鍏ㄧ殑鏂囦欢鍚嶇墖娈? 鍙繚鐣?`[A-Za-z0-9._-]`, 鍏朵綑鏇挎崲涓?`_`銆?/// `agent_type` / `run_id` 閫氬父宸叉槸瀹夊叏瀛楃, 杩欓噷鏄槻寰℃€у厹搴? 閬垮厤璺緞绌胯秺 / 闈炴硶鏂囦欢鍚嶃€?
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

        // 绗竴琛? 蹇呭惈瀛楁 + level=error + kind=llm_stream
        let v0: serde_json::Value = serde_json::from_str(lines[0]).expect("line 0 is JSON");
        assert_eq!(v0["level"], "error");
        assert_eq!(v0["kind"], "llm_stream");
        assert_eq!(v0["event"], "llm.stream_failed");
        assert_eq!(v0["message"], "boom");
        assert_eq!(v0["product"], PRODUCT_NAME);
        assert!(v0["time"].is_string(), "time must be RFC3339 string");
        assert!(v0["pid"].is_u64(), "pid must be a number");

        // 绗簩琛? level=warn + kind=stuck
        let v1: serde_json::Value = serde_json::from_str(lines[1]).expect("line 1 is JSON");
        assert_eq!(v1["level"], "warn");
        assert_eq!(v1["kind"], "stuck");
    }

    #[test]
    fn record_agent_event_does_not_touch_app_log_or_error_log() {
        // agent 浜嬩欢鍙啓 agent.log 鈹€鈹€ 涓嶆薄鏌?app.log / error.log銆?        // 鐢ㄧ┖ tempdir, 璋冪敤鍚庡彧鑳界湅鍒?agent.log, 涓嶅簲璇ユ湁鍏跺畠鏂囦欢銆?
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
        dump_debug_stdout_line_to(
            &dir,
            "claude",
            "run-abc",
            "{\"type\":\"system\",\"subtype\":\"init\"}",
        );
        dump_debug_stdout_line_to(&dir, "claude", "run-abc", "{\"type\":\"assistant\"}");

        // 鍚屼竴 run 澶氳 -> 鍚屼竴鏂囦欢杩藉姞, 姣忔涓€琛屻€?
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

        // 涓嶅悓 run_id -> 涓嶅悓鏂囦欢, 浜掍笉瑕嗙洊銆?
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
        // 绌烘牸 / 鏂滄潬绛夐潪娉曟枃浠跺悕瀛楃 -> '_', 闃绘柇璺緞绌胯秺銆?
        assert_eq!(sanitize_debug_id("a b/c"), "a_b_c");
        assert_eq!(sanitize_debug_id("../etc"), ".._etc");
    }
}

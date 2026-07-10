//! JSON-RPC over stdio serving loop ── flowix-cli 作为 desktop 端 sidecar 时使用。
//!
//! ## 协议
//!
//! Line-delimited JSON. 每行一个 envelope, 客户端发请求, 服务端回一行响应。
//! stdout 严格是协议 (一行一个 JSON 对象), stderr 走诊断日志 (desktop 端会
//! forward 到 `tracing`)。
//!
//! Request:
//! ```json
//! {"id": 1, "method": "memo.list", "params": {"notebook": "work"}}
//! ```
//!
//! Response (成功):
//! ```json
//! {"id": 1, "result": [...]}
//! ```
//!
//! Response (失败):
//! ```json
//! {"id": 1, "error": {"code": -32602, "message": "..."}}
//! ```
//!
//! Notification (无 `id`): 静默 drop, 不回响应。
//!
//! ## Method 命名
//!
//! Dot-namespaced, 跟 CLI verb 解耦:
//! - `notebooks.list`
//! - `memo.list` / `memo.show` / `memo.create` / `memo.write` / `memo.edit`
//!   / `memo.delete` / `memo.search`
//! - `shutdown` ── 服务端收到后清空协议流, 干净退出。
//!
//! ## 错误码
//!
//! - `CliError::Usage`   → `-32602` (Invalid params)
//! - `CliError::NotFound` → `-32004`
//! - `CliError::Io`      → `-32003`
//! - `CliError::Other`   → `-32603` (Internal error)
//! - unknown method      → `-32601` (Method not found)
//! - malformed JSON      → `-32700` (Parse error)
//!
//! ## 测试
//!
//! 入口 `run_serve` 接 `R: BufRead, W: Write` 泛型, 单元测试用 `Cursor`
//! 注入假 stdin / 捕获 stdout, 完整覆盖 happy path / 错误路径 / EOF。

use crate::{errors::CliError, fmt, store};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::Mutex;

/// 进入 serve loop, 同步阻塞, 直到 EOF / shutdown / IO 错。
///
/// `reader` 提供请求行, `writer` 接收响应行 (每行以 `\n` 结尾, 立刻 flush)。
/// 接受泛型 `R: BufRead, W: Write` 方便测试用 `Cursor` 注入。
pub fn run_serve<R: BufRead, W: Write>(reader: R, writer: W) -> Result<(), CliError> {
    let writer = Mutex::new(writer);
    for line in reader.lines() {
        let line = line.map_err(CliError::Io)?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                // 解析失败时没有 id, 只能发一条无 id 的错误通知。
                write_envelope(
                    &writer,
                    &json!({
                        "error": {"code": -32700, "message": format!("parse error: {e}")},
                    }),
                )?;
                continue;
            }
        };

        // 提取 id (可能缺失, 即 notification) / method / params
        let id = req.get("id").cloned();
        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let params = req.get("params").cloned().unwrap_or_else(|| json!({}));

        // 派发
        let outcome = dispatch(method, params);

        // shutdown 信号先捕获 (在 consume outcome 之前) ── shutdown 请求
        // 收到后等本轮响应写完再退出 loop。
        let is_shutdown_ok = method == "shutdown" && outcome.is_ok();

        // 请求 (有 id): 必须回响应。notification 静默 drop。
        if let Some(id) = id {
            let response = match outcome {
                Ok(result) => json!({ "id": id, "result": result }),
                Err(e) => {
                    let (code, message) = error_envelope(&e);
                    json!({ "id": id, "error": { "code": code, "message": message } })
                }
            };
            write_envelope(&writer, &response)?;
        }

        if is_shutdown_ok {
            return Ok(());
        }
    }
    Ok(())
}

/// 写一行 JSON 到 `writer` 并 flush。
fn write_envelope<W: Write>(writer: &Mutex<W>, env: &Value) -> Result<(), CliError> {
    let mut w = writer.lock().expect("writer mutex poisoned");
    serde_json::to_writer(&mut *w, env).map_err(|e| CliError::Other(format!("json write: {e}")))?;
    w.write_all(b"\n").map_err(CliError::Io)?;
    w.flush().map_err(CliError::Io)?;
    Ok(())
}

/// 派发 method -> 调对应 store 函数, 返回结果 `Value`。
///
/// 错误 (例如 unknown method / I/O / NotFound) 走 `Err(CliError)`, 由 `run_serve`
/// 统一包成 error envelope。
fn dispatch(method: &str, params: Value) -> Result<Value, CliError> {
    match method {
        "shutdown" => Ok(Value::Null),

        "notebooks.list" => {
            let configs = store::notebooks_list_configs()?;
            let note_counts = store::notebook_note_counts(&configs)?;
            Ok(fmt::notebooks_to_json(&configs, &note_counts))
        }

        "memo.list" => {
            let nb = require_str(&params, "notebook")?;
            let entries = store::notes_list_entries(nb)?;
            Ok(fmt::notes_to_json(&entries))
        }

        "memo.show" => {
            let id = require_str(&params, "id")?;
            Ok(store::note_show_data(id)?.to_json())
        }

        "memo.create" => {
            let nb_key = require_str(&params, "notebook")?;
            let body = require_str(&params, "body")?;
            let (mut mf, nb) = store::open_in(nb_key)?;
            store::create_note(&mut mf, &nb, body)
        }

        "memo.write" => {
            let id = require_str(&params, "id")?;
            let body = require_str(&params, "body")?;
            let (mut mf, full_id) = store::resolve_id(id)?;
            store::write_note(&mut mf, &full_id, body)
        }

        "memo.edit" => {
            let id = require_str(&params, "id")?;
            let old = require_str(&params, "old")?;
            let new = require_str(&params, "new")?;
            let dry_run = params
                .get("dry_run")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let (mut mf, full_id) = store::resolve_id(id)?;
            if dry_run {
                store::preview_edit_note(&mut mf, &full_id, old, new)
            } else {
                store::edit_note(&mut mf, &full_id, old, new)
            }
        }

        "memo.delete" => {
            let id = require_str(&params, "id")?;
            let (mut mf, full_id) = store::resolve_id(id)?;
            let file_path = mf.find_memo_file_path(&full_id);
            store::delete_note(&mut mf, &full_id, file_path.as_deref())
        }

        "memo.search" => {
            let q = require_str(&params, "query")?;
            let nb_filter = params.get("notebook").and_then(|v| v.as_str());
            let limit = params.get("limit").and_then(|v| v.as_u64()).unwrap_or(20) as usize;
            let results = store::search_hits(q, nb_filter, limit)?;
            Ok(store::search_results_to_value(q, &results))
        }

        other => Err(CliError::UnknownMethod(other.to_string())),
    }
}

/// 强制要求 `params` 含 `field` 字段且为字符串。`params` 不是 object 或
/// 字段缺失/类型错都报 `Usage` 错误 (-32602 Invalid params)。
fn require_str<'a>(params: &'a Value, field: &str) -> Result<&'a str, CliError> {
    let obj = params
        .as_object()
        .ok_or_else(|| CliError::Usage(format!("params must be a JSON object with `{field}`")))?;
    obj.get(field)
        .and_then(|v| v.as_str())
        .ok_or_else(|| CliError::Usage(format!("params.{field} is required and must be a string")))
}

/// `CliError` -> (JSON-RPC code, message) 映射。
fn error_envelope(err: &CliError) -> (i32, String) {
    let code = match err {
        CliError::Usage(_) => -32602,
        CliError::NotFound(_) => -32004,
        CliError::Io(_) => -32003,
        CliError::Other(_) => -32603,
        CliError::UnknownMethod(_) => -32601,
    };
    (code, err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// 跑一次 serve, 收集 stdout 字节。返回 (内部 Result, 捕获的字符串)。
    fn serve_collect(input: &str) -> (Result<(), CliError>, String) {
        let reader = Cursor::new(input.as_bytes().to_vec());
        let mut buf: Vec<u8> = Vec::new();
        let result = run_serve(reader, &mut buf);
        let captured = String::from_utf8(buf).expect("writer should produce utf8");
        (result, captured)
    }

    #[test]
    fn happy_path_shutdown_exits_cleanly() {
        let req = r#"{"id":1,"method":"shutdown","params":{}}"#;
        let (result, captured) = serve_collect(&(req.to_string() + "\n"));
        assert!(result.is_ok(), "shutdown should return Ok");
        let lines: Vec<&str> = captured.lines().collect();
        assert_eq!(lines.len(), 1, "should write exactly one response line");
        let env: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(env["id"], 1);
        assert!(env.get("result").is_some(), "shutdown returns result:null");
    }

    #[test]
    fn unknown_method_returns_method_not_found() {
        let req = r#"{"id":42,"method":"does.not.exist","params":{}}"#;
        let (_, captured) = serve_collect(&(req.to_string() + "\n"));
        let env: Value = serde_json::from_str(captured.trim()).unwrap();
        assert_eq!(env["id"], 42);
        assert_eq!(env["error"]["code"], -32601, "unknown method -> -32601");
    }

    #[test]
    fn malformed_json_returns_parse_error() {
        let input = "not json at all\n".to_string();
        let (_, captured) = serve_collect(&input);
        let env: Value = serde_json::from_str(captured.trim()).unwrap();
        assert_eq!(env["error"]["code"], -32700, "bad json -> -32700");
    }

    #[test]
    fn empty_lines_are_skipped() {
        // 3 个空行 + 1 个 shutdown → 仍然只输出 1 个 response
        let input = "\n\n\n".to_string() + r#"{"id":7,"method":"shutdown","params":{}}"# + "\n";
        let (_, captured) = serve_collect(&input);
        let lines: Vec<&str> = captured.lines().collect();
        assert_eq!(lines.len(), 1, "empty lines should be skipped silently");
    }

    #[test]
    fn missing_params_object_returns_usage_error() {
        // memo.list 没传 notebook
        let req = r#"{"id":3,"method":"memo.list","params":{}}"#;
        let (_, captured) = serve_collect(&(req.to_string() + "\n"));
        let env: Value = serde_json::from_str(captured.trim()).unwrap();
        assert_eq!(env["id"], 3);
        assert_eq!(env["error"]["code"], -32602, "Usage -> -32602");
        let msg = env["error"]["message"].as_str().unwrap();
        assert!(msg.contains("notebook"), "error msg mentions missing field");
    }

    #[test]
    fn notification_without_id_is_silent() {
        // notification: 没有 id 字段, 派发仍然发生, 但不写任何响应。
        let input = r#"{"method":"shutdown","params":{}}"#.to_string() + "\n";
        let (result, captured) = serve_collect(&input);
        // notification 收到后 is_ok() → 走 shutdown 退出逻辑。
        assert!(result.is_ok());
        assert!(
            captured.is_empty(),
            "notification produces no response line"
        );
    }

    #[test]
    fn require_str_rejects_non_object_params() {
        let err = require_str(&Value::String("hi".into()), "id").unwrap_err();
        assert_eq!(err.exit_code(), 2, "Usage -> exit code 2");
    }

    #[test]
    fn require_str_rejects_missing_field() {
        let params = json!({"other": "x"});
        let err = require_str(&params, "id").unwrap_err();
        assert!(err.to_string().contains("id"));
    }

    #[test]
    fn require_str_rejects_non_string_field() {
        let params = json!({"id": 42});
        let err = require_str(&params, "id").unwrap_err();
        assert!(err.to_string().contains("string"));
    }

    #[test]
    fn multiple_requests_in_sequence() {
        // shutdown 前所有请求都得处理, 各回一行响应。
        let input = r#"{"id":1,"method":"unknown.x","params":{}}
{"id":2,"method":"also.unknown","params":{}}
{"id":3,"method":"shutdown","params":{}}
"#
        .to_string();
        let (_, captured) = serve_collect(&input);
        let lines: Vec<&str> = captured.lines().collect();
        assert_eq!(lines.len(), 3, "3 requests → 3 response lines");
        for (i, line) in lines.iter().enumerate() {
            let env: Value = serde_json::from_str(line).unwrap();
            assert_eq!(env["id"], (i + 1) as i64);
        }
    }

    #[test]
    fn error_envelope_mapping() {
        assert_eq!(error_envelope(&CliError::Usage("x".into())).0, -32602);
        assert_eq!(error_envelope(&CliError::NotFound("x".into())).0, -32004);
        assert_eq!(
            error_envelope(&CliError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "x"
            )))
            .0,
            -32003
        );
        assert_eq!(error_envelope(&CliError::Other("x".into())).0, -32603);
        assert_eq!(
            error_envelope(&CliError::UnknownMethod("x".into())).0,
            -32601
        );
    }
}

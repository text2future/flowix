// 涓?claude/codex/hermes 涓嶅悓, simple_cli 娌℃湁鐙珛鐨?history 瀛愭ā鍧?鈹€鈹€
// Gemini / OpenClaw 鐨?session 浠嶇敱鍚勮嚜鐨?`~/.gemini/` / `~/.openclaw/`
// 鐩綍鎸佹湁, 浣嗗墠绔?UI 涓嶇洿鎺ュ垪鍘嗗彶 (鍙湪鏈?session 鍐?chat_stream), 鎵€浠?// 杩欓噷淇濇寔鍗曟枃浠跺嵆鍙€?//
// 鏁翠釜 simple_cli 瀛愭ā鍧楃殑瀛樺湪鎰忎箟: 鎶?Gemini + OpenClaw 涓ょ "绾?stdout
// 鏂囨湰杈撳嚭" 鐨?small CLI 鏁村悎鍒颁竴涓?manager 鍚庨潰, 鍏变韩 ExternalRunRegistry
// 娉ㄥ唽琛?+ kill_child_tree 绛?shared 宸ュ叿, 涓嶅啀璁╁崟涓?vendor 鑷繁閫犱竴浠姐€?
mod cli;
pub use cli::*;

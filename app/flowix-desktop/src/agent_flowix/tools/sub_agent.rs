use rllm::chat::Tool;

use super::function_tool;

pub const TOOL_NAME: &str = "sub_agent";

pub fn sub_agent_tool() -> Tool {
    function_tool(
        TOOL_NAME,
        "Run a bounded read-only sub-agent with its own system prompt and user prompt. The user prompt may contain plain text plus image URLs/paths and video URLs/paths. Supported image and video sources are passed through as multimodal content parts. Remote video URLs are passed by URL; local video files are inlined as data URLs when small enough. Use this for delegated research, file lookup, multimodal inspection, and question answering. The sub-agent can query available directories and read/list/search files, but it cannot write or edit files.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "system_prompt": {
                    "type": "string",
                    "description": "System instructions for the sub-agent."
                },
                "user_prompt": {
                    "type": "string",
                    "description": "The user's task. May include ordinary text, image links/paths, and video links."
                },
                "max_tool_cycles": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 8,
                    "description": "Optional maximum number of read-only tool-call cycles. Defaults to 4."
                }
            },
            "required": ["system_prompt", "user_prompt"]
        }),
    )
}

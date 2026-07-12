use rllm::chat::ChatResponse;
use rllm::{FunctionCall as LlmFunctionCall, ToolCall as LlmToolCall};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub(super) struct ChatMessageReq {
    pub(super) role: String,
    /// OpenAI 允许 assistant 在携带 tool_calls 时 content 为 null / 缺省。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) content: Option<ChatMessageContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) tool_calls: Option<Vec<LlmToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) tool_call_id: Option<String>,
}

#[derive(Serialize)]
#[serde(untagged)]
pub(super) enum ChatMessageContent {
    Text(String),
    Parts(Vec<ChatContentPart>),
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum ChatContentPart {
    Text { text: String },
    ImageUrl { image_url: ImageUrlContent },
    VideoUrl { video_url: VideoUrlContent },
}

#[derive(Serialize)]
pub(super) struct ImageUrlContent {
    pub(super) url: String,
}

#[derive(Serialize)]
pub(super) struct VideoUrlContent {
    pub(super) url: String,
}

#[derive(Serialize)]
pub(super) struct ChatCompletionsRequest {
    pub(super) model: String,
    pub(super) messages: Vec<ChatMessageReq>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) temperature: Option<f32>,
    pub(super) stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) tools: Option<Vec<ToolReq>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reasoning_split: Option<bool>,
}

#[derive(Serialize)]
pub(super) struct ToolReq {
    #[serde(rename = "type")]
    pub(super) tool_type: String,
    pub(super) function: FunctionSchema,
}

#[derive(Serialize)]
pub(super) struct FunctionSchema {
    pub(super) name: String,
    pub(super) description: String,
    pub(super) parameters: serde_json::Value,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub(super) struct ChatCompletionsResponse {
    pub(super) choices: Vec<Choice>,
    #[serde(default)]
    pub(super) usage: Option<Usage>,
}

#[derive(Deserialize, Debug)]
pub(super) struct Choice {
    pub(super) message: Message,
}

#[derive(Deserialize, Debug)]
pub(super) struct Message {
    pub(super) content: Option<String>,
    #[serde(default)]
    pub(super) tool_calls: Option<Vec<MessageToolCall>>,
}

#[derive(Deserialize, Debug)]
pub(super) struct MessageToolCall {
    pub(super) id: String,
    #[serde(rename = "type")]
    pub(super) call_type: String,
    pub(super) function: FunctionCall,
}

#[derive(Deserialize, Debug)]
pub(super) struct FunctionCall {
    pub(super) name: String,
    pub(super) arguments: String,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[allow(dead_code)]
pub(super) struct Usage {
    pub(super) prompt_tokens: Option<u32>,
    pub(super) completion_tokens: Option<u32>,
    pub(super) total_tokens: Option<u32>,
    pub(super) input_tokens: Option<u32>,
    pub(super) cached_input_tokens: Option<u32>,
    pub(super) output_tokens: Option<u32>,
    pub(super) reasoning_output_tokens: Option<u32>,
    pub(super) model_context_window: Option<u32>,
    pub(super) prompt_tokens_details: Option<PromptTokensDetails>,
    pub(super) completion_tokens_details: Option<CompletionTokensDetails>,
    pub(super) input_tokens_details: Option<PromptTokensDetails>,
    pub(super) output_tokens_details: Option<CompletionTokensDetails>,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[allow(dead_code)]
pub(super) struct PromptTokensDetails {
    pub(super) cached_tokens: Option<u32>,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[allow(dead_code)]
pub(super) struct CompletionTokensDetails {
    pub(super) reasoning_tokens: Option<u32>,
}

// Streaming response types (for parsing SSE from OpenAI API)
#[derive(Deserialize, Debug, Clone)]
#[allow(dead_code)]
pub(super) struct ApiStreamChunk {
    pub(super) choices: Vec<ApiStreamChoice>,
    #[serde(default)]
    pub(super) usage: Option<Usage>,
}

#[derive(Deserialize, Debug, Clone)]
#[allow(dead_code)]
pub(super) struct ApiStreamChoice {
    pub(super) delta: ApiStreamDelta,
    #[serde(default)]
    pub(super) finish_reason: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
#[allow(dead_code)]
pub(super) struct ApiStreamDelta {
    #[serde(default)]
    pub(super) content: Option<String>,
    #[serde(default)]
    pub(super) tool_calls: Option<Vec<ApiStreamToolCall>>,
    #[serde(default)]
    pub(super) reasoning_content: Option<String>,
    #[serde(default)]
    pub(super) reasoning_details: Option<Vec<ReasoningDetail>>,
}

#[derive(Deserialize, Debug, Clone)]
#[allow(dead_code)]
pub(super) struct ReasoningDetail {
    #[serde(rename = "type")]
    pub(super) detail_type: Option<String>,
    pub(super) id: Option<String>,
    pub(super) format: Option<String>,
    pub(super) index: Option<usize>,
    pub(super) text: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub(super) struct ApiStreamToolCall {
    /// The LLM-assigned position of this tool call within the current
    /// assistant turn. Required to disambiguate parallel `tool_calls`
    /// emitted in a single delta — without it we cannot tell which call
    /// an `id` / `name` / `arguments` chunk belongs to and would clobber
    /// them into one bucket. The OpenAI spec guarantees `index` is unique
    /// and stable within a turn (0, 1, 2, ...). Some providers omit it on
    /// single-tool-call responses, so we default to 0.
    #[serde(default)]
    pub(super) index: Option<usize>,
    pub(super) id: Option<String>,
    #[serde(rename = "type")]
    pub(super) call_type: Option<String>,
    pub(super) function: Option<ApiStreamFunction>,
}

#[derive(Deserialize, Debug, Clone)]
pub(super) struct ApiStreamFunction {
    pub(super) name: Option<String>,
    pub(super) arguments: Option<String>,
}

impl std::fmt::Display for ChatCompletionsResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "ChatCompletionsResponse {{ choices: {} }}",
            self.choices.len()
        )
    }
}

impl ChatResponse for ChatCompletionsResponse {
    fn text(&self) -> Option<String> {
        self.choices.first().and_then(|c| c.message.content.clone())
    }

    fn tool_calls(&self) -> Option<Vec<LlmToolCall>> {
        let calls = self.choices.first()?.message.tool_calls.as_ref()?;

        Some(
            calls
                .iter()
                .map(|c| LlmToolCall {
                    id: c.id.clone(),
                    call_type: c.call_type.clone(),
                    function: LlmFunctionCall {
                        name: c.function.name.clone(),
                        arguments: c.function.arguments.clone(),
                    },
                })
                .collect(),
        )
    }
}

pub(super) fn text_content(text: impl Into<String>) -> ChatMessageContent {
    ChatMessageContent::Text(text.into())
}

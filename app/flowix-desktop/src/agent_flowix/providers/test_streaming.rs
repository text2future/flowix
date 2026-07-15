//! Test script to verify streaming works correctly
//! Run with: cargo test --test test_streaming -- --nocapture

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    #[derive(Deserialize, Debug, Clone)]
    struct ApiStreamChunk {
        choices: Vec<ApiStreamChoice>,
    }

    #[derive(Deserialize, Debug, Clone)]
    struct ApiStreamChoice {
        delta: ApiStreamDelta,
    }

    #[derive(Deserialize, Debug, Clone)]
    struct ApiStreamDelta {
        content: Option<String>,
    }

    #[test]
    fn test_sse_parsing() {
        // Simulate SSE data from MiniMax API
        let sse_data = r#"data: {"id":"test","choices":[{"index":0,"delta":{"content":"Hello","role":"assistant"}}],"created":123,"model":"test","object":"chat.completion.chunk","usage":null}
data: {"id":"test","choices":[{"index":0,"delta":{"content":" World","role":"assistant"}}],"created":124,"model":"test","object":"chat.completion.chunk","usage":null}
data: [DONE]"#;

        let mut chunks: Vec<String> = Vec::new();
        for line in sse_data.lines() {
            if line.starts_with("data: ") {
                let json_str = line.trim_start_matches("data: ").trim();
                if json_str == "[DONE]" {
                    break;
                }
                if let Ok(response) = serde_json::from_str::<ApiStreamChunk>(json_str) {
                    if let Some(delta) = response.choices.first().map(|c| c.delta.clone()) {
                        if let Some(content) = delta.content {
                            chunks.push(content);
                        }
                    }
                }
            }
        }

        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0], "Hello");
        assert_eq!(chunks[1], " World");
        println!("SSE parsing test passed! Got chunks: {:?}", chunks);
    }

    #[test]
    fn test_stream_chunk_deserialization() {
        let json1 = r#"{"choices":[{"delta":{"content":"Hello"}}]}"#;
        let json2 = r#"{"choices":[{"delta":{"content":" World"}}]}"#;

        let chunk1: ApiStreamChunk = serde_json::from_str(json1).unwrap();
        let chunk2: ApiStreamChunk = serde_json::from_str(json2).unwrap();

        let text1 = chunk1
            .choices
            .first()
            .unwrap()
            .delta
            .content
            .clone()
            .unwrap();
        let text2 = chunk2
            .choices
            .first()
            .unwrap()
            .delta
            .content
            .clone()
            .unwrap();

        assert_eq!(text1, "Hello");
        assert_eq!(text2, " World");
        println!("Stream chunk deserialization test passed!");
    }

    #[test]
    fn test_tool_call_parsing() {
        #[derive(Deserialize, Debug)]
        #[allow(dead_code)]
        struct ApiStreamToolCall {
            id: Option<String>,
            #[serde(rename = "type")]
            call_type: Option<String>,
            function: Option<ApiStreamFunction>,
        }

        #[derive(Deserialize, Debug)]
        #[allow(dead_code)]
        struct ApiStreamFunction {
            name: Option<String>,
            arguments: Option<String>,
        }

        let json = r#"{
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "id": "call_123",
                        "type": "function",
                        "function": {
                            "name": "available_dirs",
                            "arguments": "{}"
                        }
                    }]
                }
            }]
        }"#;

        #[derive(Deserialize, Debug)]
        struct DeltaWithToolCalls {
            tool_calls: Option<Vec<ApiStreamToolCall>>,
        }

        #[derive(Deserialize, Debug)]
        struct ChoiceWithToolCalls {
            delta: DeltaWithToolCalls,
        }

        #[derive(Deserialize, Debug)]
        struct ChunkWithToolCalls {
            choices: Vec<ChoiceWithToolCalls>,
        }

        let chunk: ChunkWithToolCalls = serde_json::from_str(json).unwrap();
        let tool_call = chunk
            .choices
            .first()
            .unwrap()
            .delta
            .tool_calls
            .as_ref()
            .unwrap()
            .first()
            .unwrap();

        assert_eq!(tool_call.id.as_ref().unwrap(), "call_123");
        assert_eq!(
            tool_call.function.as_ref().unwrap().name.as_ref().unwrap(),
            "available_dirs"
        );
        println!("Tool call parsing test passed!");
    }
}

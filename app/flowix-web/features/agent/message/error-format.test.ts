import { describe, expect, it } from "vitest";
import { formatAgentErrorMessage } from "@features/agent/message/error-format";

/** Wrap a raw `reason` in the flowix-agent LLM-unavailable envelope shape. */
function envelope(reason: string): string {
  return `(LLM 暂时不可用，原因: ${reason})`;
}

describe("formatAgentErrorMessage", () => {
  it("collapses Raw response JSON to its error.message", () => {
    const content = envelope(
      "Stream failed: Response format error: API error 400. Raw response: " +
        '{"type":"error","error":{"type":"bad_request_error","message":"invalid params, chat content is empty (2013)","http_code":"400"},"request_id":"06b01abbde4a0eda83851fe9e7b584d7"}',
    );
    expect(formatAgentErrorMessage(content)).toBe(
      "(LLM 暂时不可用，原因: invalid params, chat content is empty (2013))",
    );
  });

  it("handles OpenAI-style {error:{message}} envelopes", () => {
    expect(
      formatAgentErrorMessage(
        envelope('Raw response: {"error":{"message":"rate limited","code":429}}'),
      ),
    ).toBe("(LLM 暂时不可用，原因: rate limited)");
  });

  it("falls back to top-level message / detail / error string", () => {
    expect(
      formatAgentErrorMessage(envelope('Raw response: {"message":"no key"}')),
    ).toBe("(LLM 暂时不可用，原因: no key)");
    expect(
      formatAgentErrorMessage(
        envelope('Raw response: {"detail":"upstream timeout"}'),
      ),
    ).toBe("(LLM 暂时不可用，原因: upstream timeout)");
    expect(
      formatAgentErrorMessage(envelope('Raw response: {"error":"bad gateway"}')),
    ).toBe("(LLM 暂时不可用，原因: bad gateway)");
  });

  it("ignores braces inside JSON string values when matching", () => {
    // The raw body may contain a `}` inside a string; brace-matching must not
    // stop early.
    expect(
      formatAgentErrorMessage(
        envelope('Raw response: {"error":{"message":"unexpected } in body"}}'),
      ),
    ).toBe("(LLM 暂时不可用，原因: unexpected } in body)");
  });

  it("is a no-op for plain assistant text and empty content", () => {
    expect(formatAgentErrorMessage("here is a normal answer")).toBe(
      "here is a normal answer",
    );
    expect(formatAgentErrorMessage("")).toBe("");
  });

  it("does not touch normal answers that merely quote Raw response JSON", () => {
    // A debugging answer that happens to contain "Raw response: {error:...}"
    // must NOT be reformatted -- only the "(LLM ..." envelope is an error.
    const answer =
      'To debug, inspect the Raw response: {"error":{"message":"bad"}} field.';
    expect(formatAgentErrorMessage(answer)).toBe(answer);
  });

  it("returns the original content when Raw response body is not JSON", () => {
    // e.g. an HTML error page -- don't lose the original text.
    const content = envelope("Raw response: <html>Bad Request</html>");
    expect(formatAgentErrorMessage(content)).toBe(content);
  });

  it("also cleans legacy mojibake envelopes written before the Rust fix", () => {
    // Historical persisted messages used doubly-encoded Chinese + the raw JSON;
    // "(LLM " prefix survives the mojibake, so the display layer still cleans
    // them without a data migration.
    const legacy =
      "(LLM 鏆傛椂涓嶅彲鐢? 鍘熷洜: Stream failed: Raw response: " +
      '{"error":{"message":"invalid params, chat content is empty (2013)"}})';
    expect(formatAgentErrorMessage(legacy)).toBe(
      "(LLM 暂时不可用，原因: invalid params, chat content is empty (2013))",
    );
  });
});

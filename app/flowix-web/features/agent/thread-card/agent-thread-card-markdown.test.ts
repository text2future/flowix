import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fillWithAgentThreadCardMarkdownHtml,
  highlightAgentThreadCardCodeBlocks,
  renderAgentThreadCardMarkdownToHtml,
} from "@features/agent/thread-card/agent-thread-card-markdown";

function countMathNodes(html: string): number {
  return html.match(/data-latex=/g)?.length ?? 0;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("agent thread card Markdown math", () => {
  it.each(["user", "assistant"])(
    "renders raw HTML from %s messages as text",
    (role) => {
      const container = document.createElement("div");
      container.innerHTML = renderAgentThreadCardMarkdownToHtml(
        `<script>alert(1)</script>\n\n<strong>${role}</strong>`,
      );

      expect(container.querySelector("script")).toBeNull();
      expect(container.querySelector("strong")).toBeNull();
      expect(container.textContent).toContain("<script>alert(1)</script>");
      expect(container.textContent).toContain(`<strong>${role}</strong>`);
    },
  );

  it("continues to render Markdown formatting while HTML is escaped", () => {
    const html = renderAgentThreadCardMarkdownToHtml(
      "**bold** and `code`\n\n<div>literal</div>",
    );

    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("&lt;div&gt;literal&lt;/div&gt;");
  });

  it("rejects entity-encoded dangerous protocols in raw anchors", () => {
    const container = document.createElement("div");
    container.innerHTML = renderAgentThreadCardMarkdownToHtml(
      '<a href="javascript&#x3A;alert(1)">run</a>',
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("javascript&#x3A;alert(1)");
  });

  it("keeps the desktop webview origin on local agent links", () => {
    const container = document.createElement("div");
    container.innerHTML = renderAgentThreadCardMarkdownToHtml(
      '<a href="tauri://localhost/Users/rop/project/src/app.ts:12">source</a>',
    );

    expect(container.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe(
      "tauri://localhost/Users/rop/project/src/app.ts:12",
    );
  });

  it("recognizes Codex inline LaTeX delimiters", () => {
    const html = renderAgentThreadCardMarkdownToHtml(
      "Assume \\(q,k\\in\\mathbb R^d\\).",
    );

    expect(html).toContain("agent-thread-card__math--inline");
    expect(html).toContain('data-latex="q,k\\in\\mathbb R^d"');
  });

  it("wraps display math in a horizontal scroller", () => {
    const html = renderAgentThreadCardMarkdownToHtml(
      "\\[S_tq_t\\in\\mathbb R^d\\] after",
    );

    expect(html).toContain("agent-thread-card__math--block");
    expect(html).toContain("agent-thread-card__math-scroller");
    expect(html).toContain('data-latex="S_tq_t\\in\\mathbb R^d"');
    expect(html).toContain("after");
  });

  it("recognizes double-dollar display math", () => {
    const html = renderAgentThreadCardMarkdownToHtml(
      "$$\n\\sum_{k=1}^{n} k\n$$\nafter",
    );

    expect(countMathNodes(html)).toBe(1);
    expect(html).toContain("agent-thread-card__math--block");
    expect(html).toContain('data-latex="\\sum_{k=1}^{n} k"');
    expect(html).toContain("after");
  });

  it("waits for the closing delimiter before rendering streaming math", () => {
    expect(
      countMathNodes(renderAgentThreadCardMarkdownToHtml("before \\[x^2")),
    ).toBe(0);
    expect(
      countMathNodes(renderAgentThreadCardMarkdownToHtml("before\n\\[x^2\\]")),
    ).toBe(1);
  });

  it("leaves fenced and multiline inline code untouched", () => {
    const html = renderAgentThreadCardMarkdownToHtml(
      "```md\n~~~\n\\(x\\)\n```\n\n`alpha\n\\(y\\)\nomega`",
    );

    expect(countMathNodes(html)).toBe(0);
  });

  it("marks fenced code blocks for isolation from the editor styles", () => {
    const container = document.createElement("div");
    container.innerHTML = renderAgentThreadCardMarkdownToHtml(
      "```ts\nconst answer = 42;\n```",
    );

    const pre = container.querySelector("pre");
    expect(pre?.classList.contains("agent-thread-card__message-code-block")).toBe(
      true,
    );
    expect(pre?.querySelector("code")?.textContent).toBe("const answer = 42;\n");
  });

  it("shows the canonical language label for fenced code blocks", () => {
    const container = document.createElement("div");
    fillWithAgentThreadCardMarkdownHtml(
      container,
      renderAgentThreadCardMarkdownToHtml("```ts\nconst answer = 42;\n```"),
    );

    expect(container.querySelector("pre")?.dataset.languageLabel).toBe(
      "TypeScript",
    );
  });

  it("highlights code blocks before the message container is mounted", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderAgentThreadCardMarkdownToHtml(
      "```css\nfont-family: Inter;\n```",
    );

    await highlightAgentThreadCardCodeBlocks(container);

    expect(container.querySelector("code span[style*='color']")).not.toBeNull();
  });

  it("applies token colors when CSP blocks setting inline style attributes", async () => {
    // Packaged Tauri adds a style-src nonce, which blocks setAttribute('style')
    // even when the original policy contains 'unsafe-inline'. CSSOM remains
    // available. jsdom does not enforce CSP, so emulate its attribute boundary.
    const setAttribute = Element.prototype.setAttribute;
    vi.spyOn(Element.prototype, "setAttribute").mockImplementation(function (
      this: Element, name: string, value: string,
    ) {
      if (name.toLowerCase() !== "style") setAttribute.call(this, name, value);
    });
    const container = document.createElement("div");
    container.innerHTML = renderAgentThreadCardMarkdownToHtml(
      '```json\n{"type": "table", "revision": 12}\n```',
    );

    await highlightAgentThreadCardCodeBlocks(container);

    const colors = Array.from(container.querySelectorAll<HTMLElement>("code span"))
      .map((span) => span.style.color).filter(Boolean);
    expect(new Set(colors).size).toBeGreaterThan(1);
  });

  it("uses Text for fenced blocks without a language", () => {
    const container = document.createElement("div");
    fillWithAgentThreadCardMarkdownHtml(
      container,
      renderAgentThreadCardMarkdownToHtml("```\nplain text\n```"),
    );

    expect(container.querySelector("pre")?.dataset.languageLabel).toBe("Text");
  });

  it("does not replace ordinary text or parse link destinations", () => {
    const html = renderAgentThreadCardMarkdownToHtml(
      "FLOWIX_MATH_INLINE_0 [docs](https://example.com/\\(x\\)) and \\(y\\)",
    );

    expect(countMathNodes(html)).toBe(1);
    expect(html).toContain("FLOWIX_MATH_INLINE_0");
    expect(html).toContain("<a href=");
    expect(html).toContain('data-latex="y"');
  });

  it("renders KaTeX and copies the original LaTeX", async () => {
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const container = document.createElement("div");
    document.body.append(container);

    fillWithAgentThreadCardMarkdownHtml(
      container,
      renderAgentThreadCardMarkdownToHtml("\\[x^2\\]"),
      "复制 LaTeX",
    );

    await vi.waitFor(() => {
      expect(container.querySelector(".katex")).not.toBeNull();
    });

    const math = container.querySelector<HTMLElement>(
      ".agent-thread-card__math",
    );
    expect(
      math?.querySelector(".agent-thread-card__math-scroller .katex-display"),
    ).not.toBeNull();
    expect(
      math?.querySelector('.vlist > span[style*="top"]'),
    ).not.toBeNull();
    expect(math?.hasAttribute("data-math-probe")).toBe(false);
    expect(math?.hasAttribute("data-math-debug")).toBe(false);
    expect(math?.getAttribute("aria-label")).toBe("复制 LaTeX");
    expect(math?.title).toBe("复制 LaTeX");

    math?.click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("x^2");
    });
    expect(math?.classList.contains("agent-thread-card__math--copied")).toBe(
      true,
    );

    writeText.mockClear();
    math?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("x^2");
    });

    writeText.mockClear();
    math?.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("x^2");
    });
  });
});

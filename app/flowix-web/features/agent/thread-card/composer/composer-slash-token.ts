import { Node, type Editor, type JSONContent, type MarkdownToken } from "@tiptap/core";
import type { AgentTypeKey } from "@/types/agent";

export interface ComposerSlashTokenOptions {
  onRemove?: () => void;
}

export interface ComposerSlashTokenValue {
  command: string;
  agentType?: AgentTypeKey;
}

const SLASH_TOKEN_RE = /^\[\/([a-z0-9_-]+)\]\(flowix:\/\/slash\/(?:(deepseek-harness|codex)\/)?([a-z0-9_-]+)\)/i;
const SLASH_TOKEN_GLOBAL_RE = /\[\/([a-z0-9_-]+)\]\(flowix:\/\/slash\/(?:(deepseek-harness|codex)\/)?([a-z0-9_-]+)\)/gi;
const LEGACY_DSH_COMMANDS = new Set([
  "compact",
  "skill",
  "goal",
  "plan",
  "export",
  "model",
]);

export const ComposerSlashToken = Node.create<ComposerSlashTokenOptions>({
  name: "composerSlashToken",
  priority: 1000,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() { return { onRemove: undefined }; },
  addAttributes() {
    return {
      command: { default: "" },
      agentType: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-composer-slash]", getAttrs: (dom) => ({
      command: (dom as HTMLElement).getAttribute("data-composer-slash") ?? "",
      agentType: (dom as HTMLElement).getAttribute("data-composer-slash-agent") || null,
    }) }];
  },

  renderHTML({ node }) {
    const command = String(node.attrs?.command ?? "");
    const agentType = String(node.attrs?.agentType ?? "");
    return ["span", {
      "data-composer-slash": command,
      ...(agentType ? { "data-composer-slash-agent": agentType } : {}),
      class: "agent-thread-card__slash-token",
    }, `/${command}`];
  },

  markdownTokenizer: {
    name: "composerSlashToken",
    level: "inline" as const,
    start(src: string) {
      const index = src.indexOf("flowix://slash/");
      return index >= 0 ? index : -1;
    },
    tokenize(src: string) {
      const match = SLASH_TOKEN_RE.exec(src);
      return match ? {
        type: "composerSlashToken",
        raw: match[0],
        href: `flowix://slash/${match[2] ? `${match[2]}/` : ""}${match[3]}`,
        text: `/${match[1]}`,
      } : undefined;
    },
  },

  parseMarkdown(token: MarkdownToken) {
    const href = String(token.href ?? "");
    const path = href.replace(/^flowix:\/\/slash\//i, "");
    const parts = path.split("/");
    const agentType = parts[0] === "deepseek-harness" || parts[0] === "codex"
      ? parts[0]
      : undefined;
    const command = (agentType ? parts[1] : parts[0]) ||
      String(token.text ?? "").replace(/^\//, "");
    return { type: "composerSlashToken", attrs: { command, agentType } };
  },

  renderMarkdown(node: JSONContent) {
    const command = String(node.attrs?.command ?? "");
    const agentType = String(node.attrs?.agentType ?? "");
    return `[/${command}](flowix://slash/${agentType ? `${agentType}/` : ""}${command})`;
  },

  addNodeView() {
    return ({ node, view, getPos }) => {
      const button = document.createElement("button");
      const command = String(node.attrs.command ?? "");
      button.type = "button";
      button.className = "agent-thread-card__slash-token";
      button.textContent = `/${command}`;
      button.title = "点击移除命令";
      button.setAttribute("aria-label", `移除 /${command} 命令`);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (pos === undefined) return;
        view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
        view.focus();
      });
      return { dom: button };
    };
  },
});

export function getComposerSlashToken(editor: Editor): ComposerSlashTokenValue | null {
  let value: ComposerSlashTokenValue | null = null;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "composerSlashToken" && value === null) {
      const agentType = String(node.attrs.agentType ?? "").trim();
      value = {
        command: String(node.attrs.command ?? ""),
        ...(agentType ? { agentType: agentType as AgentTypeKey } : {}),
      };
      return false;
    }
    return value === null;
  });
  return value;
}

export function insertComposerSlashToken(
  editor: Editor,
  command: string,
  agentType?: AgentTypeKey,
): void {
  const { selection } = editor.state;
  editor.chain().focus().deleteRange({ from: 1, to: selection.to })
    .insertContent({
      type: "composerSlashToken",
      attrs: { command, agentType: agentType ?? null },
    }).run();
}

/** Convert persisted slash chips back into the provider command/prompt line. */
export function composerSlashMarkdownToPrompt(markdown: string): string {
  return markdown.replace(
    SLASH_TOKEN_GLOBAL_RE,
    (match, command: string, scopedAgent: string | undefined, _encoded: string, offset: number, source: string) => {
      // Unscoped chips are legacy data. Preserve old DSH drafts while keeping
      // the product-only permission chips UI-only as before.
      if (
        scopedAgent &&
        scopedAgent.toLowerCase() !== "deepseek-harness" &&
        scopedAgent.toLowerCase() !== "codex" ||
        (!scopedAgent && !LEGACY_DSH_COMMANDS.has(command.toLowerCase()))
      ) {
        return "";
      }
      const after = source.slice(offset + match.length);
      // A chip is an atom, so text typed immediately after it needs the
      // separator that the native DSH command parser expects.
      return `/${command}${after && !/^\s/u.test(after) ? " " : ""}`;
    },
  );
}

export function removeComposerSlashToken(editor: Editor): void {
  let found: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found === null && node.type.name === "composerSlashToken") {
      found = { from: pos, to: pos + node.nodeSize };
      return false;
    }
    return found === null;
  });
  if (!found) return;
  const range = found as { from: number; to: number };
  editor.view.dispatch(editor.state.tr.delete(range.from, range.to));
}

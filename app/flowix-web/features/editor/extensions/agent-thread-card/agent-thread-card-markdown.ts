import { Marked } from "marked";
import { normalizeAgentTypeKey } from "@/lib/agent-types";

export const DEFAULT_AGENT_THREAD_CARD_TITLE = "";

export function escapeAgentThreadCardAttr(
  value: string | null | undefined,
): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function unescapeAgentThreadCardAttr(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

export function parseAgentThreadCardAttrs(
  rawAttrs: string,
): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /(\w+)="((?:\\"|\\\\|[^"])*)"/g;
  let match: RegExpExecArray | null;

  while ((match = attrRe.exec(rawAttrs))) {
    attrs[match[1]] = unescapeAgentThreadCardAttr(match[2]);
  }

  return attrs;
}

export function encodeAgentThreadCardInputDraft(
  value: string | null | undefined,
): string {
  return encodeURIComponent(value ?? "");
}

export function decodeAgentThreadCardInputDraft(
  value: string | null | undefined,
): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const cardMarked = new Marked({
  async: false,
  gfm: true,
  breaks: true,
});

export function renderAgentThreadCardMarkdownToHtml(content: string): string {
  if (!content || !content.trim()) return "";
  return cardMarked.parse(content) as string;
}

export function fillWithAgentThreadCardMarkdownHtml(
  container: HTMLElement,
  html: string,
): void {
  container.replaceChildren();
  if (!html) return;

  const template = document.createElement("template");
  template.innerHTML = html;
  container.append(template.content.cloneNode(true));
}

export function parseAgentThreadCardMarkdown(token: any) {
  const attrs = parseAgentThreadCardAttrs(token.attrs || "");
  return {
    type: "agentThreadCard",
    attrs: {
      threadId: attrs.threadId || null,
      instanceId: attrs.instanceId || null,
      title: attrs.title || DEFAULT_AGENT_THREAD_CARD_TITLE,
      typeKey: normalizeAgentTypeKey(attrs.agentType as string | undefined),
      agentRoleMemoId: attrs.agentRoleMemoId || null,
      agentRoleName: attrs.agentRoleName || null,
      collapsed: attrs.collapsed === "true",
      inputDraft: attrs.inputDraft
        ? decodeAgentThreadCardInputDraft(attrs.inputDraft)
        : null,
    },
  };
}

export function renderAgentThreadCardMarkdown(node: {
  attrs?: Record<string, unknown>;
}): string {
  const threadId = escapeAgentThreadCardAttr(node.attrs?.threadId as string);
  const instanceId = escapeAgentThreadCardAttr(node.attrs?.instanceId as string);
  const title = escapeAgentThreadCardAttr(node.attrs?.title as string);
  const typeKey = normalizeAgentTypeKey(
    node.attrs?.typeKey as string | undefined,
  );
  const agentRoleMemoId = escapeAgentThreadCardAttr(
    node.attrs?.agentRoleMemoId as string,
  );
  const agentRoleName = escapeAgentThreadCardAttr(
    node.attrs?.agentRoleName as string,
  );
  const collapsed = !!node.attrs?.collapsed;
  const inputDraft = escapeAgentThreadCardAttr(
    encodeAgentThreadCardInputDraft(node.attrs?.inputDraft as string),
  );

  return `::agent-thread-card{instanceId="${instanceId}" threadId="${threadId}" title="${title}" agentType="${typeKey}" agentRoleMemoId="${agentRoleMemoId}" agentRoleName="${agentRoleName}" collapsed="${collapsed}" inputDraft="${inputDraft}"}\n`;
}

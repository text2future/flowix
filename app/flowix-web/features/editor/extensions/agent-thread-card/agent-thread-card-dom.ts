import type { EditorView } from "@tiptap/pm/view";

export interface ScrollSnapshot {
  editorScrollContainer: HTMLElement | null;
  editorScrollTop: number;
  editorScrollLeft: number;
  windowScrollX: number;
  windowScrollY: number;
}

export function focusAgentThreadCardInput(
  view: EditorView,
  pos: number,
): void {
  requestAnimationFrame(() => {
    if (view.isDestroyed) return;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return;

    const input = dom.querySelector("textarea");
    if (!(input instanceof HTMLTextAreaElement)) return;

    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  });
}

export function focusWithoutScroll(element: HTMLElement): void {
  element.focus({ preventScroll: true });
}

export function extractDocumentContext(view: EditorView | undefined): string {
  if (!view) return "";
  const blocks: string[] = [];
  view.state.doc.descendants((node) => {
    if (node.type.name === "agentThreadCard") {
      return false;
    }
    if (node.isBlock && node.textContent.trim()) {
      blocks.push(node.textContent.trim());
    }
    return true;
  });
  return blocks.join("\n\n");
}

export function getEventElement(event: Event): Element | null {
  if (event.target instanceof Element) return event.target;
  if (event.target instanceof globalThis.Node) {
    return event.target.parentElement;
  }
  return null;
}

export function consumeEditorPopoverDismissPointer(event: PointerEvent): void {
  const target = getEventElement(event);
  if (!target?.closest(".markdown-editor, .ProseMirror, .agent-thread-card")) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
}

const AGENT_THREAD_CARD_MESSAGE_AFFECTING_KEYS = [
  "threadId",
  "typeKey",
  "agentRoleMemoId",
  "agentRoleName",
] as const;

export function canSkipMessageRebuild(
  oldAttrs: Record<string, unknown>,
  newAttrs: Record<string, unknown>,
): boolean {
  for (const key of AGENT_THREAD_CARD_MESSAGE_AFFECTING_KEYS) {
    if (oldAttrs[key] !== newAttrs[key]) return false;
  }
  return true;
}

export function isAgentThreadCardInteractiveTarget(target: Element): boolean {
  return !!target.closest(
    [
      "button",
      "a[href]",
      "textarea",
      "input",
      "select",
      '[role="button"]',
      ".agent-thread-card__composer",
      ".agent-thread-card__access-popover",
      ".agent-thread-card__composer-role-popover",
      ".agent-thread-card__message-reasoning-header",
    ].join(","),
  );
}

export function isAgentThreadCardSelectableMessageText(
  target: Element,
): boolean {
  return !!target.closest(
    [
      ".agent-thread-card__message--user .agent-thread-card__message-content",
      ".agent-thread-card__message--assistant .agent-thread-card__message-content",
    ].join(","),
  );
}

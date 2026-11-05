import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { AgentTypeKey } from "@/types/agent";
import type { WorkspaceColumnId } from "@features/workspace/public/host-api";
import {
  DEFAULT_AGENT_TYPE_KEY,
  getAgentType,
  normalizeAgentTypeKey,
} from "@/lib/agent-types";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";
import {
  DEFAULT_AGENT_THREAD_CARD_TITLE as DEFAULT_TITLE,
  encodeAgentThreadCardInputAttachments,
  decodeAgentThreadCardInputAttachments,
} from "@features/agent/thread-card/agent-thread-card-markdown";
import { agentThreadCardMarkdownSpec } from "@features/agent/thread-card/agent-thread-card-markdown-spec";
import { focusAgentThreadCardInput } from "@features/agent/thread-card/agent-thread-card-dom";
import { AgentThreadCardView } from "@features/agent/thread-card/agent-thread-card-view";
import {
  restoreRemovedAgentThreadCardInstance,
  terminateAgentThreadCardRuntime,
} from "@features/agent/thread-card/agent-thread-card-cleanup";
import { getCurrentThreadCardSource } from "@features/agent/thread-card/runtime/thread-card-source";
import {
  LEGACY_THREAD_CARD_IMAGES_HTML_ATTRIBUTE,
  THREAD_CARD_ATTACHMENTS_ATTRIBUTE,
  THREAD_CARD_ATTACHMENTS_HTML_ATTRIBUTE,
} from "@features/agent/thread-card/composer/composer-attachment-compat";

export const SKIP_AGENT_THREAD_CARD_CLEANUP_META =
  "flowixSkipAgentThreadCardCleanup";

function collectAgentThreadCards(
  doc: ProseMirrorNode,
): Record<string, unknown>[] {
  const cards: Record<string, unknown>[] = [];
  doc.descendants((node) => {
    if (node.type.name !== "agentThreadCard") return;
    cards.push(node.attrs as Record<string, unknown>);
  });
  return cards;
}

function isSameAgentThreadCard(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  const beforeInstanceId =
    typeof before.instanceId === "string" ? before.instanceId : "";
  const afterInstanceId =
    typeof after.instanceId === "string" ? after.instanceId : "";
  if (beforeInstanceId && beforeInstanceId === afterInstanceId) return true;
  const beforeThreadId =
    typeof before.threadId === "string" ? before.threadId : "";
  const afterThreadId =
    typeof after.threadId === "string" ? after.threadId : "";
  return !!beforeThreadId && beforeThreadId === afterThreadId;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    agentThreadCard: {
      insertAgentThreadCard: (options?: {
        typeKey?: AgentTypeKey;
        replaceRange?: { from: number; to: number };
        initialPrompt?: string;
        autoSubmit?: boolean;
      }) => ReturnType;
    };
  }
}

export const AgentThreadCard = Node.create<{ workspaceHost: WorkspaceColumnId }>({
  addOptions() {
    return { workspaceHost: "column-1" };
  },

  name: "agentThreadCard",
  group: "block",
  content: "",
  // The card owns a nested composer and must not become the outer editor's
  // implicit NodeSelection when it is the first block or when a preceding
  // paragraph is deleted. Explicit card actions (drag handle/context menu)
  // still activate it through activateAgentThreadCard().
  selectable: false,
  draggable: false,

  addAttributes() {
    return {
      threadId: { default: null },
      instanceId: { default: null },
      title: { default: DEFAULT_TITLE },
      typeKey: { default: DEFAULT_AGENT_TYPE_KEY },
      collapsed: { default: false },
      fullscreen: { default: false },
      initialPrompt: { default: null },
      autoSubmit: { default: false },
      inputDraft: { default: null },
      [THREAD_CARD_ATTACHMENTS_ATTRIBUTE]: { default: [] },
    };
  },

  parseHTML() {
    return [
      {
        tag: "section[data-agent-thread-card]",
        getAttrs: (dom) => {
          const element = dom as HTMLElement;
          return {
            threadId: element.getAttribute("data-thread-id") || null,
            instanceId: element.getAttribute("data-instance-id") || null,
            title: element.getAttribute("data-title") || DEFAULT_TITLE,
            typeKey: normalizeAgentTypeKey(
              element.getAttribute("data-agent-type"),
            ),
            collapsed: element.getAttribute("data-collapsed") === "true",
            fullscreen: element.getAttribute("data-fullscreen") === "true",
            inputDraft: element.getAttribute("data-input-draft") || null,
            [THREAD_CARD_ATTACHMENTS_ATTRIBUTE]: decodeAgentThreadCardInputAttachments(
              element.getAttribute(THREAD_CARD_ATTACHMENTS_HTML_ATTRIBUTE)
                ?? element.getAttribute(LEGACY_THREAD_CARD_IMAGES_HTML_ATTRIBUTE),
            ),
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const threadId = node.attrs.threadId || "";
    const instanceId = node.attrs.instanceId || "";
    const title = node.attrs.title || DEFAULT_TITLE;
    const typeKey = normalizeAgentTypeKey(node.attrs.typeKey as string | null);
    const type = getAgentType(typeKey);
    const collapsed = !!node.attrs.collapsed;
    const fullscreen = !!node.attrs.fullscreen;
    const inputDraft = node.attrs.inputDraft || "";
    const inputAttachments = encodeAgentThreadCardInputAttachments(
      node.attrs[THREAD_CARD_ATTACHMENTS_ATTRIBUTE],
    );

    return [
      "section",
      mergeAttributes({
        "data-agent-thread-card": "true",
        "data-thread-id": threadId,
        "data-instance-id": instanceId,
        "data-agent-type": typeKey,
        "data-collapsed": collapsed ? "true" : "false",
        "data-fullscreen": fullscreen ? "true" : "false",
        "data-input-draft": inputDraft,
        [THREAD_CARD_ATTACHMENTS_HTML_ATTRIBUTE]: inputAttachments,
        // Preserve copy/paste compatibility with releases that only read this key.
        [LEGACY_THREAD_CARD_IMAGES_HTML_ATTRIBUTE]: inputAttachments,
        class: collapsed
          ? "agent-thread-card agent-thread-card--collapsed"
          : "agent-thread-card",
        contenteditable: "false",
      }),
      [
        "div",
        { class: "agent-thread-card__container" },
        [
          "div",
          { class: "agent-thread-card__title" },
          title ? `${type.name} · ${title}` : type.name,
        ],
        [
          "div",
          { class: "agent-thread-card__empty" },
          "Use current note to start an AI session",
        ],
        [
          "div",
          { class: "agent-composer" },
          [
            "div",
            {
              class: "agent-composer__input",
              contenteditable: "true",
            },
            inputDraft,
          ],
          [
            "button",
            {
              class: "agent-composer__send",
              type: "button",
              "aria-label": "Send",
            },
          ],
        ],
      ],
    ];
  },

  addCommands() {
    return {
      insertAgentThreadCard:
        (options) =>
        ({ state, dispatch, tr }) => {
          const nodeType = state.schema.nodes[this.name];
          if (!nodeType) return false;
          const typeKey = normalizeAgentTypeKey(
            options?.typeKey ??
              useAgentSessionStore.getState().sessionMeta.activeAgentTypeKey,
          );
          if (!dispatch) return true;
          const instance = useAgentSessionStore.getState().createInstance({
            agentType: typeKey,
            title: DEFAULT_TITLE,
            threadId: null,
            source: getCurrentThreadCardSource(),
            // 插入时只记录 runtime 默认和 notebookId；cwd / paths 在首次
            // send 前解析并冻结，避开插入阶段 store 尚未 hydrate 的 race。
            runtimeConfig: buildInitialInstanceRuntimeConfig(typeKey),
          });
          const node = nodeType.create({
            threadId: null,
            instanceId: instance.instanceId,
            title: DEFAULT_TITLE,
            typeKey,
            collapsed: false,
            fullscreen: false,
            initialPrompt: options?.initialPrompt ?? null,
            autoSubmit: !!options?.autoSubmit,
            inputDraft: null,
            [THREAD_CARD_ATTACHMENTS_ATTRIBUTE]: [],
          });
          const from = options?.replaceRange?.from ?? state.selection.from;
          const to = options?.replaceRange?.to ?? from;
          tr.replaceWith(from, to, node);
          const after = from + node.nodeSize;
          const paragraphType = state.schema.nodes.paragraph;

          if (paragraphType) {
            tr.insert(after, paragraphType.create());
            tr.setSelection(TextSelection.create(tr.doc, after + 1));
          }
          dispatch(tr);
          focusAgentThreadCardInput(this.editor.view, from);
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) {
            return null;
          }
          if (
            transactions.some((transaction) =>
              transaction.getMeta(SKIP_AGENT_THREAD_CARD_CLEANUP_META),
            )
          ) {
            return null;
          }
          const before = collectAgentThreadCards(oldState.doc);
          const after = collectAgentThreadCards(newState.doc);
          for (const attrs of before) {
            if (!after.some((candidate) => isSameAgentThreadCard(attrs, candidate))) {
              terminateAgentThreadCardRuntime(attrs);
            }
          }
          for (const attrs of after) {
            if (!before.some((candidate) => isSameAgentThreadCard(candidate, attrs))) {
              restoreRemovedAgentThreadCardInstance(attrs);
            }
          }
          return null;
        },
      }),
    ];
  },

  addNodeView() {
    return (props) =>
      new AgentThreadCardView(
        props.node,
        props.view,
        typeof props.getPos === "function" ? props.getPos : undefined,
        this.options.workspaceHost,
      );
  },

  ...agentThreadCardMarkdownSpec,
});

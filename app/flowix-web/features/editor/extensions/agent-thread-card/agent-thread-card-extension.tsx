import { Node, mergeAttributes } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { AgentTypeKey } from "@/types/agent";
import {
  DEFAULT_AGENT_TYPE_KEY,
  getAgentType,
  normalizeAgentTypeKey,
} from "@/lib/agent-types";
import { useChatStore } from "@features/agent/store/chat-store";
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";
import {
  DEFAULT_AGENT_THREAD_CARD_TITLE as DEFAULT_TITLE,
  parseAgentThreadCardMarkdown,
  renderAgentThreadCardMarkdown,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-markdown";
import { focusAgentThreadCardInput } from "@features/editor/extensions/agent-thread-card/agent-thread-card-dom";
import { AgentThreadCardView } from "@features/editor/extensions/agent-thread-card/agent-thread-card-view";
import { terminateAgentThreadCardRuntime } from "@features/editor/extensions/agent-thread-card/agent-thread-card-cleanup";
import { getCurrentThreadCardSource } from "@features/editor/extensions/agent-thread-card/runtime/thread-card-source";

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

export const AgentThreadCard = Node.create({
  name: "agentThreadCard",
  group: "block",
  content: "",
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      threadId: { default: null },
      instanceId: { default: null },
      title: { default: DEFAULT_TITLE },
      typeKey: { default: DEFAULT_AGENT_TYPE_KEY },
      agentRoleMemoId: { default: null },
      agentRoleName: { default: null },
      collapsed: { default: false },
      initialPrompt: { default: null },
      autoSubmit: { default: false },
      inputDraft: { default: null },
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
            agentRoleMemoId:
              element.getAttribute("data-agent-role-memo-id") || null,
            agentRoleName: element.getAttribute("data-agent-role-name") || null,
            collapsed: element.getAttribute("data-collapsed") === "true",
            inputDraft: element.getAttribute("data-input-draft") || null,
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
    const agentRoleMemoId = node.attrs.agentRoleMemoId || "";
    const agentRoleName = node.attrs.agentRoleName || "";
    const collapsed = !!node.attrs.collapsed;
    const inputDraft = node.attrs.inputDraft || "";

    return [
      "section",
      mergeAttributes({
        "data-agent-thread-card": "true",
        "data-thread-id": threadId,
        "data-instance-id": instanceId,
        "data-agent-type": typeKey,
        "data-agent-role-memo-id": agentRoleMemoId,
        "data-agent-role-name": agentRoleName,
        "data-collapsed": collapsed ? "true" : "false",
        "data-input-draft": inputDraft,
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
          "Use current note to start an AI conversation",
        ],
        [
          "div",
          { class: "agent-thread-card__composer" },
          [
            "textarea",
            { placeholder: "Ask AI to handle this task", rows: "1" },
            inputDraft,
          ],
          [
            "button",
            {
              class: "agent-thread-card__send",
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
            options?.typeKey ?? useChatStore.getState().activeAgentTypeKey,
          );
          const instance = useAgentConversationStore.getState().createInstance({
            agentType: typeKey,
            title: DEFAULT_TITLE,
            threadId: null,
            source: getCurrentThreadCardSource(),
            role: undefined,
            // 让 instance 自己持有 cwd / folders 快照, 而不是每次
            // send 时再依赖全局 store 兜底链 → 修 启动 race 下 cwd 缺失
            runtimeConfig: buildInitialInstanceRuntimeConfig(typeKey),
          });
          const node = nodeType.create({
            threadId: null,
            instanceId: instance.instanceId,
            title: DEFAULT_TITLE,
            typeKey,
            agentRoleMemoId: null,
            agentRoleName: null,
            collapsed: false,
            initialPrompt: options?.initialPrompt ?? null,
            autoSubmit: !!options?.autoSubmit,
            inputDraft: null,
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
          if (dispatch) {
            dispatch(tr);
            focusAgentThreadCardInput(this.editor.view, from);
          }
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    const cleanupSelectedCard = () => {
      const { selection } = this.editor.state;
      if (
        !(selection instanceof NodeSelection) ||
        selection.node.type.name !== this.name
      ) {
        return false;
      }
      terminateAgentThreadCardRuntime(selection.node.attrs);
      return false;
    };

    return {
      Backspace: cleanupSelectedCard,
      Delete: cleanupSelectedCard,
    };
  },

  addNodeView() {
    return (props) =>
      new AgentThreadCardView(
        props.node,
        props.view,
        typeof props.getPos === "function" ? props.getPos : undefined,
      );
  },

  markdownTokenizer: {
    name: "agentThreadCard",
    level: "block" as const,
    start(src: string) {
      return src.indexOf("::agent-thread-card");
    },
    tokenize(src: string): any {
      const match = /^::agent-thread-card\{([^}]*)\}[ \t]*(?:\n|$)/.exec(src);
      if (!match) return undefined;
      return { type: "agentThreadCard", raw: match[0], attrs: match[1] };
    },
  },

  parseMarkdown(token: any) {
    return parseAgentThreadCardMarkdown(token);
  },

  renderMarkdown(node) {
    return renderAgentThreadCardMarkdown(node);
  },
});

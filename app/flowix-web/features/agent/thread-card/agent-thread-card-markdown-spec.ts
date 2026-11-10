import { Extension } from "@tiptap/core";
import { scanHead } from '@features/editor/public/markdown-tokenizer-api';

import {
  FLOWIX_AGENT_THREAD_CARD_MARKER,
  parseAgentThreadCardMarkdown,
  parseFlowixAgentThreadCardComment,
  renderAgentThreadCardMarkdown,
} from "./agent-thread-card-markdown";

/**
 * Markdown-only half of the Agent Thread Card node.
 *
 * The editor node lives in `agent-thread-card-extension.tsx`, which pulls in
 * the NodeView, the session store and the runtime cleanup. Background parsers
 * (the markdown worker) only need tokenizing/parsing, so the spec is kept in a
 * module without DOM or store dependencies and spread into both places.
 */
export const agentThreadCardMarkdownSpec = {
  markdownTokenizer: {
    name: "agentThreadCard",
    level: "block" as const,
    start(src: string): number {
      const head = scanHead(src);
      const commentIndex = head.search(
        new RegExp(`^<!--[ \\t]*${FLOWIX_AGENT_THREAD_CARD_MARKER}[ \\t]+\\{`, "m"),
      );
      const legacyIndex = head.indexOf("::agent-thread-card");
      if (commentIndex < 0) return legacyIndex;
      if (legacyIndex < 0) return commentIndex;
      return Math.min(commentIndex, legacyIndex);
    },
    tokenize(src: string) {
      const comment = parseFlowixAgentThreadCardComment(src);
      if (comment) {
        return {
          type: "agentThreadCard",
          raw: comment.raw,
          metadata: comment.metadata,
        };
      }

      const match = /^::agent-thread-card\{([^}]*)\}[ \t]*(?:\n|$)/.exec(src);
      if (!match) return undefined;
      return { type: "agentThreadCard", raw: match[0], attrs: match[1] };
    },
  },

  parseMarkdown(token: unknown) {
    return parseAgentThreadCardMarkdown(token);
  },

  renderMarkdown(node: { attrs?: Record<string, unknown> }) {
    return renderAgentThreadCardMarkdown(node);
  },
};

/** Registry entry for parsers that never mount an editor NodeView. */
export const AgentThreadCardMarkdownExtension = Extension.create({
  name: "agentThreadCard",
  ...agentThreadCardMarkdownSpec,
});

import { Node, type Editor, type JSONContent, type MarkdownToken } from "@tiptap/core";
import skillLibraryIconSvg from "@/assets/skill-library.svg?raw";
import {
  createInlineAtomCloseIcon,
  createInlineAtomNodeView,
  deleteInlineAtomNode,
  deleteAdjacentInlineAtom,
} from "@features/editor/extensions/shared/inline-atom-nodeview";

const SKILL_HREF_PREFIX = "flowix://skill/codex/";
const SKILL_TOKEN_RE = /^\[([^\]\n]*)\]\(flowix:\/\/skill\/codex\/([^\s)]+)\)/i;
const SKILL_TOKEN_GLOBAL_RE = /\[([^\]\n]*)\]\(flowix:\/\/skill\/codex\/([^\s)]+)\)/gi;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

/** Remove the provider namespace marker from the visible skill label. */
export function formatCodexSkillDisplayName(name: string): string {
  const normalized = name.trim();
  const qualified = /^\$?[^:\s]+:\s*(.*)$/u.exec(normalized);
  if (qualified) return qualified[1].trim();
  return normalized.replace(/^\$/, "").trim();
}

/** Prefer a skill's human-readable display name, falling back to its command name. */
export function preferredComposerSkillName(name: string, displayName?: string | null): string {
  return displayName?.trim() || name.trim();
}

export function displayNameForComposerSkill(
  name: string,
  displayName?: string | null,
): string {
  return displayName?.trim() || formatCodexSkillDisplayName(name);
}

export const ComposerSkillToken = Node.create({
  name: "composerSkillToken",
  priority: 1000,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      name: { default: "" },
      displayName: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-composer-skill]", getAttrs: (dom) => ({
      name: (dom as HTMLElement).getAttribute("data-composer-skill") ?? "",
      displayName: (dom as HTMLElement).getAttribute("data-composer-skill-display-name") || null,
    }) }];
  },

  renderHTML({ node }) {
    const name = String(node.attrs?.name ?? "");
    const displayName = String(node.attrs?.displayName ?? "");
    return ["span", {
      "data-composer-skill": name,
      ...(displayName ? { "data-composer-skill-display-name": displayName } : {}),
      class: "agent-composer__skill-token",
    }, displayNameForComposerSkill(name, displayName)];
  },

  markdownTokenizer: {
    name: "composerSkillToken",
    level: "inline" as const,
    start(src: string) {
      const index = src.indexOf(`(${SKILL_HREF_PREFIX}`);
      return index >= 0 ? Math.max(0, src.lastIndexOf("[", index)) : -1;
    },
    tokenize(src: string) {
      const match = SKILL_TOKEN_RE.exec(src);
      return match ? {
        type: "composerSkillToken",
        raw: match[0],
        text: match[1],
        href: `${SKILL_HREF_PREFIX}${match[2]}`,
      } : undefined;
    },
  },

  parseMarkdown(token: MarkdownToken) {
    const href = String(token.href ?? "");
    const encodedName = href.slice(SKILL_HREF_PREFIX.length);
    return {
      type: "composerSkillToken",
      attrs: {
        name: safeDecode(encodedName),
        displayName: String(token.text ?? "").trim() || null,
      },
    };
  },

  renderMarkdown(node: JSONContent) {
    const name = String(node.attrs?.name ?? "").trim();
    if (!name) return "";
    const displayName = displayNameForComposerSkill(
      name,
      typeof node.attrs?.displayName === "string" ? node.attrs.displayName : undefined,
    );
    return `[${escapeMarkdownLinkText(displayName)}](${SKILL_HREF_PREFIX}${encodeURIComponent(name)})`;
  },

  addNodeView() {
    return ({ node, view, getPos }) => {
      const name = String(node.attrs.name ?? "");
      const displayName = displayNameForComposerSkill(
        name,
        typeof node.attrs.displayName === "string" ? node.attrs.displayName : undefined,
      );
      const iconTemplate = document.createElement("template");
      iconTemplate.innerHTML = skillLibraryIconSvg;
      const nodeView = createInlineAtomNodeView({
        caretGeometry: 'single-line',
        wrapperClassName: "agent-composer__inline-atom-wrapper agent-composer__skill-token-wrapper",
        cardClassName: "agent-composer__skill-token",
        leadingIcon: iconTemplate.content.firstElementChild ?? undefined,
        label: displayName,
        labelClassName: "agent-composer__skill-token-label",
        title: `$${name}`,
        hoverActions: [{
          ariaLabel: `移除 Skill ${displayName}`,
          icon: createInlineAtomCloseIcon(),
          onClick: () => deleteInlineAtomNode(
            view,
            node,
            () => typeof getPos === "function" ? getPos() : undefined,
          ),
        }],
      });
      return nodeView;
    };
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => deleteAdjacentInlineAtom(this.editor, "composerSkillToken", "before"),
      Delete: () => deleteAdjacentInlineAtom(this.editor, "composerSkillToken", "after"),
    };
  },
});

export function insertComposerSkillToken(
  editor: Editor,
  name: string,
  displayName?: string,
): void {
  const { selection } = editor.state;
  editor.chain()
    .focus()
    .deleteRange({ from: 1, to: selection.to })
    .insertContent([
      { type: "composerSkillToken", attrs: { name, displayName: displayName || null } },
      { type: "text", text: " " },
    ])
    .run();
}

/** Convert persisted Skill cards back into the Codex invocation syntax. */
export function composerSkillMarkdownToPrompt(markdown: string): string {
  return markdown.replace(
    SKILL_TOKEN_GLOBAL_RE,
    (match, _displayName: string, encodedName: string, offset: number, source: string) => {
      const name = safeDecode(encodedName);
      const after = source.slice(offset + match.length);
      return `$${name}${after && !/^\s/u.test(after) ? " " : ""}`;
    },
  );
}

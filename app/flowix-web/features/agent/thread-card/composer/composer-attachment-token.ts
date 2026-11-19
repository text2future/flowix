import { Node, type JSONContent, type MarkdownToken } from "@tiptap/core";
import {
  COMPOSER_ATTACHMENT_HTML_ATTRIBUTE,
  COMPOSER_ATTACHMENT_NODE_NAME,
  LEGACY_COMPOSER_IMAGE_HTML_ATTRIBUTE,
} from "./composer-attachment-compat";
import { createComposerAttachmentNodeView } from "./composer-attachment-node-view";
import { deleteAdjacentInlineAtom } from "@features/editor/extensions/shared/inline-atom-nodeview";

const TOKEN_RE = /^\u27e6attachment:([^:\u27e7]*):([^:\u27e7]*):([^:\u27e7]*)\u27e7/;
const TOKEN_GLOBAL_RE = /\u27e6attachment:([^:\u27e7]*):([^:\u27e7]*):([^:\u27e7]*)\u27e7/g;

function decode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Inline attachment data and serialization. View behavior lives in adjacent modules. */
export const ComposerAttachmentToken = Node.create({
  name: COMPOSER_ATTACHMENT_NODE_NAME,
  priority: 1100,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      path: { default: "" },
      name: { default: "" },
      // Preserve the old image-token default for drafts created before MIME
      // data was serialized; new generic attachments always store their type.
      mimeType: { default: "image/png" },
    };
  },
  parseHTML() {
    return [{
      tag: `span[${COMPOSER_ATTACHMENT_HTML_ATTRIBUTE}], span[${LEGACY_COMPOSER_IMAGE_HTML_ATTRIBUTE}]`,
      getAttrs: (dom) => {
        const element = dom as HTMLElement;
        return {
          path: element.getAttribute(COMPOSER_ATTACHMENT_HTML_ATTRIBUTE)
            ?? element.getAttribute(LEGACY_COMPOSER_IMAGE_HTML_ATTRIBUTE)
            ?? "",
          name: element.getAttribute("data-name") ?? "",
          mimeType: element.getAttribute("data-mime-type") ?? "image/png",
        };
      },
    }];
  },
  renderHTML({ node }) {
    const path = String(node.attrs.path ?? "");
    return ["span", {
      [COMPOSER_ATTACHMENT_HTML_ATTRIBUTE]: path,
      // Older Flowix releases read this attribute when pasting saved HTML.
      [LEGACY_COMPOSER_IMAGE_HTML_ATTRIBUTE]: path,
      "data-name": String(node.attrs.name ?? ""),
      "data-mime-type": String(node.attrs.mimeType ?? "application/octet-stream"),
      class: "agent-composer__attachment-token",
    }, String(node.attrs.name ?? "")];
  },
  markdownTokenizer: {
    name: COMPOSER_ATTACHMENT_NODE_NAME,
    level: "inline" as const,
    start(src: string) { return src.indexOf("⟦attachment:"); },
    tokenize(src: string) {
      const match = TOKEN_RE.exec(src);
      return match ? {
        type: COMPOSER_ATTACHMENT_NODE_NAME,
        raw: match[0],
        path: decode(match[1]),
        name: decode(match[2]),
        mimeType: decode(match[3]),
      } : undefined;
    },
  },
  parseMarkdown(token: MarkdownToken) {
    return {
      type: COMPOSER_ATTACHMENT_NODE_NAME,
      attrs: {
        path: String(token.path ?? ""),
        name: String(token.name ?? ""),
        mimeType: String(token.mimeType ?? "image/png"),
      },
    };
  },
  renderMarkdown(node: JSONContent) {
    const { path, name, mimeType } = node.attrs ?? {};
    return `⟦attachment:${encodeURIComponent(String(path ?? ""))}:${encodeURIComponent(String(name ?? ""))}:${encodeURIComponent(String(mimeType ?? "image/png"))}⟧`;
  },
  addNodeView() {
    return ({ node, view, getPos }) => createComposerAttachmentNodeView({ node, view, getPos });
  },
  addKeyboardShortcuts() {
    return {
      Backspace: () => deleteAdjacentInlineAtom(this.editor, COMPOSER_ATTACHMENT_NODE_NAME, "before"),
      Delete: () => deleteAdjacentInlineAtom(this.editor, COMPOSER_ATTACHMENT_NODE_NAME, "after"),
    };
  },
});

function toLocalFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const encodeSegments = (value: string) => value.split("/").map(encodeURIComponent).join("/");

  if (normalized.startsWith("//")) {
    const [host = "", ...segments] = normalized.slice(2).split("/");
    return `file://${encodeURIComponent(host)}/${segments.map(encodeURIComponent).join("/")}`;
  }
  const windowsDrive = /^([a-z]):\/(.*)$/i.exec(normalized);
  if (windowsDrive) {
    return `file:///${windowsDrive[1].toUpperCase()}:/${encodeSegments(windowsDrive[2])}`;
  }
  const absolutePath = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeSegments(absolutePath)}`;
}

function escapeMarkdownLinkLabel(label: string): string {
  return label
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\\/g, "\\\\")
    .replace(/([\[\]])/g, "\\$1");
}

export function composerAttachmentMarkdownToPrompt(markdown: string): string {
  return markdown.replace(
    TOKEN_GLOBAL_RE,
    (_token, encodedPath: string, encodedName: string, encodedMimeType: string) => {
      const path = decode(encodedPath);
      const name = decode(encodedName) || path.split(/[\\/]/u).pop() || "Attachment";
      const mimeType = decode(encodedMimeType).toLowerCase();
      if (mimeType.startsWith("image/")) return "";
      if (!path) return "";
      return `[${escapeMarkdownLinkLabel(name)}](${toLocalFileUrl(path)})`;
    },
  );
}

/** Keep image tokens in user-visible Markdown while leaving model prompts untouched. */
export function composerAttachmentMarkdownToDisplay(markdown: string): string {
  return markdown.replace(
    TOKEN_GLOBAL_RE,
    (_token, encodedPath: string, encodedName: string, encodedMimeType: string) => {
      const path = decode(encodedPath);
      const name = decode(encodedName) || path.split(/[\\/]/u).pop() || "Attachment";
      const mimeType = decode(encodedMimeType).toLowerCase();
      if (mimeType.startsWith("image/")) {
        if (!path) return "";
        const href = `flowix://agent-image-attachment?path=${encodeURIComponent(path)}`;
        return `[${escapeMarkdownLinkLabel(name)}](${href})`;
      }
      if (!path) return "";
      return `[${escapeMarkdownLinkLabel(name)}](${toLocalFileUrl(path)})`;
    },
  );
}

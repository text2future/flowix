import { Node, type Editor, type JSONContent, type MarkdownToken } from "@tiptap/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Database } from "lucide-react";
import folderOutlineSvg from "@/assets/folder-outline.svg?raw";
import { COLLECTION_AGENT_REFERENCE_LINK_TITLE } from "@features/collection/public/agent-reference-api";
import {
  createInlineAtomCloseIcon,
  createInlineAtomNodeView,
  deleteInlineAtomNode,
  deleteAdjacentInlineAtom,
} from "@features/editor/extensions/shared/inline-atom-nodeview";

export interface ComposerFolderTokenValue {
  path: string;
  displayName?: string;
  kind?: "folder" | "collection";
  collectionMetadata?: string;
}

const FOLDER_HREF_PREFIX = "flowix://folder/";
const COLLECTION_HREF_PREFIX = "flowix://collection/";
const FOLDER_TOKEN_RE = /^\[([^\]\n]*)\]\(flowix:\/\/(folder|collection)\/([^\s)]+)\)/i;
const FOLDER_TOKEN_GLOBAL_RE = /\[([^\]\n]*)\]\(flowix:\/\/(folder|collection)\/([^\s)]+)\)/gi;

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

function encodePathSegments(value: string): string {
  return value.split("/").map(encodeTokenValue).join("/");
}

function encodeTokenValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function escapeMarkdownTitle(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Convert a repository path into a Markdown-safe absolute file URL. */
function toAbsoluteFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("//")) {
    const [host = "", ...segments] = normalized.slice(2).split("/");
    return `file://${encodeURIComponent(host)}/${encodePathSegments(segments.join("/"))}`;
  }
  const windowsDrive = /^([a-z]):\/(.*)$/i.exec(normalized);
  if (windowsDrive) {
    return `file:///${windowsDrive[1].toUpperCase()}:/${encodePathSegments(windowsDrive[2])}`;
  }
  const absolutePath = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodePathSegments(absolutePath)}`;
}

function folderDisplayName(path: string, displayName?: string | null): string {
  const explicit = displayName?.trim();
  if (explicit) return explicit;
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || normalized || path;
}

export const ComposerFolderToken = Node.create({
  name: "composerFolderToken",
  priority: 1000,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      path: { default: "" },
      displayName: { default: null },
      kind: { default: "folder" },
      collectionMetadata: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-composer-folder]", getAttrs: (dom) => ({
      path: (dom as HTMLElement).getAttribute("data-composer-folder") ?? "",
      displayName: (dom as HTMLElement).getAttribute("data-composer-folder-display-name") || null,
      kind: (dom as HTMLElement).getAttribute("data-composer-folder-kind") || "folder",
      collectionMetadata: (dom as HTMLElement).getAttribute("data-composer-folder-metadata") || null,
    }) }];
  },

  renderHTML({ node }) {
    const path = String(node.attrs?.path ?? "");
    const displayName = folderDisplayName(
      path,
      typeof node.attrs?.displayName === "string" ? node.attrs.displayName : undefined,
    );
    const kind = node.attrs?.kind === "collection" ? "collection" : "folder";
    return ["span", {
      "data-composer-folder": path,
      "data-composer-folder-display-name": displayName,
      "data-composer-folder-kind": kind,
      "data-composer-folder-metadata": kind === "collection"
        ? String(node.attrs?.collectionMetadata ?? "")
        : "",
      class: "agent-composer__folder-token",
    }, `@${displayName}`];
  },

  markdownTokenizer: {
    name: "composerFolderToken",
    level: "inline" as const,
    start(src: string) {
      const indexes = [FOLDER_HREF_PREFIX, COLLECTION_HREF_PREFIX]
        .map((prefix) => src.indexOf(`(${prefix}`))
        .filter((index) => index >= 0);
      return indexes.length > 0 ? Math.max(0, src.lastIndexOf("[", Math.min(...indexes))) : -1;
    },
    tokenize(src: string) {
      const match = FOLDER_TOKEN_RE.exec(src);
      return match ? {
        type: "composerFolderToken",
        raw: match[0],
        text: match[1],
        kind: match[2].toLowerCase(),
        href: `flowix://${match[2].toLowerCase()}/${match[3]}`,
      } : undefined;
    },
  },

  parseMarkdown(token: MarkdownToken) {
    const href = String(token.href ?? "");
    const kind = href.startsWith(COLLECTION_HREF_PREFIX) ? "collection" : "folder";
    const prefix = kind === "collection" ? COLLECTION_HREF_PREFIX : FOLDER_HREF_PREFIX;
    const [encodedPath, query = ""] = href.slice(prefix.length).split("?", 2);
    const collectionMetadata = kind === "collection"
      ? new URLSearchParams(query).get("metadata")
      : null;
    return {
      type: "composerFolderToken",
      attrs: {
        path: safeDecode(encodedPath),
        displayName: String(token.text ?? "").replace(/^@/, "").trim() || null,
        kind,
        collectionMetadata,
      },
    };
  },

  renderMarkdown(node: JSONContent) {
    const path = String(node.attrs?.path ?? "").trim();
    if (!path) return "";
    const displayName = folderDisplayName(
      path,
      typeof node.attrs?.displayName === "string" ? node.attrs.displayName : undefined,
    );
    const kind = node.attrs?.kind === "collection" ? "collection" : "folder";
    const prefix = kind === "collection" ? COLLECTION_HREF_PREFIX : FOLDER_HREF_PREFIX;
    const metadata = kind === "collection" && typeof node.attrs?.collectionMetadata === "string"
      ? `?metadata=${encodeTokenValue(node.attrs.collectionMetadata)}`
      : "";
    return `[${escapeMarkdownLinkText(`@${displayName}`)}](${prefix}${encodeTokenValue(path)}${metadata})`;
  },

  addNodeView() {
    return ({ node, view, getPos }) => {
      const path = String(node.attrs.path ?? "");
      const displayName = folderDisplayName(
        path,
        typeof node.attrs.displayName === "string" ? node.attrs.displayName : undefined,
      );
      const kind = node.attrs.kind === "collection" ? "collection" : "folder";
      const iconTemplate = document.createElement("template");
      iconTemplate.innerHTML = kind === "collection"
        ? renderToStaticMarkup(createElement(Database, { "aria-hidden": true }))
        : folderOutlineSvg;
      const folderIcon = iconTemplate.content.firstElementChild;
      folderIcon?.classList.add("agent-composer__folder-token-icon");
      const nodeView = createInlineAtomNodeView({
        caretGeometry: 'single-line',
        wrapperClassName: "agent-composer__inline-atom-wrapper agent-composer__folder-token-wrapper",
        cardClassName: "agent-composer__folder-token",
        leadingIcon: folderIcon ?? undefined,
        label: displayName,
        labelClassName: "agent-composer__folder-token-label",
        title: path,
        hoverActions: [{
          ariaLabel: kind === "collection"
            ? `移除集合引用 ${displayName}`
            : `移除资料库 ${displayName}`,
          icon: createInlineAtomCloseIcon(),
          onClick: () => deleteInlineAtomNode(
            view,
            node,
            () => typeof getPos === "function" ? getPos() : undefined,
          ),
        }],
      });
      nodeView.dom.setAttribute("data-composer-folder", path);
      nodeView.dom.setAttribute("data-composer-folder-display-name", displayName);
      nodeView.dom.setAttribute("data-composer-folder-kind", kind);
      nodeView.dom.setAttribute(
        "data-composer-folder-metadata",
        kind === "collection" ? String(node.attrs.collectionMetadata ?? "") : "",
      );
      return nodeView;
    };
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => deleteAdjacentInlineAtom(this.editor, "composerFolderToken", "before"),
      Delete: () => deleteAdjacentInlineAtom(this.editor, "composerFolderToken", "after"),
    };
  },
});

export function insertComposerFolderToken(
  editor: Editor,
  path: string,
  displayName?: string,
  range?: { from: number; to: number },
): void {
  const { selection } = editor.state;
  const target = range ?? { from: selection.from, to: selection.to };
  editor.chain()
    .focus()
    .insertContentAt({ from: target.from, to: target.to }, [
      { type: "composerFolderToken", attrs: { path, displayName: displayName || null } },
      { type: "text", text: " " },
    ])
    .run();
}

/** Convert persisted folder and collection cards to absolute-path links for the agent. */
export function composerFolderMarkdownToPrompt(markdown: string): string {
  return markdown.replace(
    FOLDER_TOKEN_GLOBAL_RE,
    (_match, displayName: string, kind: string, encodedPath: string) => {
      const [encodedCollectionPath, query = ""] = encodedPath.split("?", 2);
      const path = safeDecode(encodedCollectionPath);
      const label = folderDisplayName(path, displayName.replace(/^@/, ""));
      let title = "";
      if (kind.toLowerCase() === "collection") {
        const metadata = new URLSearchParams(query).get("metadata");
        const titleValue = metadata
          ? `${COLLECTION_AGENT_REFERENCE_LINK_TITLE} ${metadata}`
          : COLLECTION_AGENT_REFERENCE_LINK_TITLE;
        title = ` '${escapeMarkdownTitle(titleValue)}'`;
      }
      return `[${escapeMarkdownLinkText(`@${label}`)}](${toAbsoluteFileUrl(path)}${title})`;
    },
  );
}

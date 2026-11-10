import { Editor, Node as TiptapNode } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Markdown } from "@tiptap/markdown";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ComposerFolderController,
  type ComposerFolderReference,
} from "./composer-folder-controller";
import type { MentionNoteItem } from "@features/editor/public/mention-data-api";

const TestNoteReference = TiptapNode.create({
  name: "noteReference",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return {
      notebookId: { default: null },
      relativePath: { default: null },
      title: { default: "" },
    };
  },
  renderHTML({ node }) {
    return ["span", { "data-test-note-reference": "true" }, String(node.attrs.title ?? "")];
  },
  renderMarkdown(node) {
    const attrs = node.attrs ?? {};
    return `[${String(attrs.title ?? "")}](flowix://open?notebookId=${encodeURIComponent(String(attrs.notebookId ?? ""))}&relativePath=${encodeURIComponent(String(attrs.relativePath ?? ""))})`;
  },
});
import {
  ComposerFolderToken,
  composerFolderMarkdownToPrompt,
} from "./composer-folder-token";

function setup(
  folders: readonly ComposerFolderReference[] = [
    { name: "flowix-main", path: "/Users/rop/Desktop/vibe/flowix-main" },
    { name: "flowix-home", path: "/Users/rop/Desktop/vibe/flowix-home" },
  ],
  options: { listNotes?: (query: string) => Promise<readonly MentionNoteItem[]> } = {},
) {
  const composer = document.createElement("div");
  const input = document.createElement("div");
  input.contentEditable = "true";
  composer.append(input);
  document.body.append(composer);
  vi.spyOn(composer, "getBoundingClientRect").mockReturnValue({
    x: 20,
    y: 300,
    left: 20,
    top: 300,
    right: 420,
    bottom: 350,
    width: 400,
    height: 50,
    toJSON: () => ({}),
  });
  const editor = new Editor({
    element: { mount: input },
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      Markdown,
      TestNoteReference,
      ComposerFolderToken,
    ],
    content: "",
    contentType: "markdown",
  });
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  } as DOMRect);
  const controller = new ComposerFolderController({
    input,
    composer,
    editor,
    listFolders: () => folders,
    listNotes: options.listNotes,
    focusInput: () => undefined,
  });
  return { composer, input, editor, controller };
}

function type(editor: Editor, value: string): void {
  editor.commands.setContent(value, { contentType: "markdown" });
  editor.commands.focus("end");
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ComposerFolderController", () => {
  it("reuses the slash menu class and filters current notebook folders after @", () => {
    const { editor, controller } = setup();
    type(editor, "请操作 @main");

    expect(document.querySelector(".agent-composer-slash-menu")).not.toBeNull();
    expect(document.querySelector(".agent-thread-card__codex-settings-title")?.textContent)
      .toBe("引用仓库");
    expect([...document.querySelectorAll(".agent-thread-card__codex-settings-title")]
      .map((item) => item.textContent)).toContain("笔记");
    expect(document.querySelectorAll(".agent-composer-slash-menu__item")).toHaveLength(1);
    expect(document.querySelector(".agent-composer-slash-menu__name")?.textContent)
      .toBe("flowix-main");
    expect(document.querySelector(".agent-composer-slash-menu__description")?.textContent)
      .toBe("/Users/rop/Desktop/vibe/flowix-main");

    controller.dispose();
    editor.destroy();
  });

  it("opens the reference menu when @ follows text without a space", () => {
    const { editor, controller } = setup();
    type(editor, "请操作@main");

    expect(document.querySelector(".agent-composer-slash-menu")).not.toBeNull();
    expect(document.querySelector(".agent-composer-slash-menu__name")?.textContent)
      .toBe("flowix-main");

    controller.dispose();
    editor.destroy();
  });

  it("does not show an empty menu when folders and notes have no matches", async () => {
    const listNotes = vi.fn(async () => [] as readonly MentionNoteItem[]);
    const { editor, controller } = setup([], { listNotes });
    type(editor, "请操作 @不存在");

    expect(document.querySelector(".agent-composer-slash-menu")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(listNotes).toHaveBeenCalledWith("不存在");
    expect(document.querySelector(".agent-composer-slash-menu")).toBeNull();

    controller.dispose();
    editor.destroy();
  });

  it("inserts a removable folder card and serializes it as an absolute-path Markdown link", () => {
    const { input, editor, controller } = setup();
    type(editor, "请操作 @flow");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    const markdown = editor.getMarkdown();
    expect(markdown).toContain("flowix://folder/%2FUsers%2Frop%2FDesktop%2Fvibe%2Fflowix-main");
    expect(composerFolderMarkdownToPrompt(markdown)).toBe(
      "请操作 [@flowix-main](file:///Users/rop/Desktop/vibe/flowix-main) ",
    );
    expect(document.querySelector(".agent-composer__folder-token-label")?.textContent)
      .toBe("flowix-main");

    controller.dispose();
    editor.destroy();
  });

  it("searches project notes across notebooks and inserts a note reference", async () => {
    const note: MentionNoteItem = {
      relativePath: "多维表格实现.md",
      filename: "多维表格实现.md",
      title: "多维表格实现",
      updatedAt: 1,
      notebookId: "nb-flowix",
      notebookName: "开发任务管理",
      notebookPath: "/Users/rop/Desktop/Notes/开发任务管理",
      originalPath: "/Users/rop/Desktop/Notes/开发任务管理/多维表格实现.md",
    };
    const listNotes = vi.fn(async (query: string) => query.includes("多维") ? [note] : []);
    const { input, editor, controller } = setup([], { listNotes });
    type(editor, "参考 @多维");

    await vi.waitFor(() => {
      expect(listNotes).toHaveBeenCalledWith("多维");
      expect(document.querySelector(".agent-composer-slash-menu__item--note")).not.toBeNull();
    });
    expect(document.querySelector(".agent-thread-card__codex-settings-title")?.textContent)
      .toBe("笔记");
    expect(document.querySelector(".agent-composer-slash-menu__item--note .agent-composer-slash-menu__name")?.textContent)
      .toBe("多维表格实现");
    expect(document.querySelector(".agent-composer-slash-menu__item--note .agent-composer-slash-menu__description")?.textContent)
      .toBe("开发任务管理");
    expect(document.querySelector(".agent-composer-slash-menu__item--note")?.textContent)
      .not.toContain("/Users/rop/Desktop/Notes/开发任务管理/多维表格实现.md");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(editor.getMarkdown()).toContain("flowix://open?notebookId=nb-flowix&relativePath=");
    expect(editor.getJSON().content?.[0]?.content?.some((item) => item.type === "noteReference"))
      .toBe(true);

    controller.dispose();
    editor.destroy();
  });

  it("does not search unfinished IME input until compositionend", async () => {
    const listNotes = vi.fn(async (query: string) => query ? [] : []);
    const { input, editor, controller } = setup([], { listNotes });

    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    type(editor, "搜索 @多维");
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(listNotes).not.toHaveBeenCalled();

    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.waitFor(() => expect(listNotes).toHaveBeenCalledWith("多维"));

    controller.dispose();
    editor.destroy();
  });
});

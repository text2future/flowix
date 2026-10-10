import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invokeHandler } from "@/lib/shortcuts/handler-registry";

import {
  ComposerController,
  ComposerDraftController,
  createAgentComposerDom,
  disposeAgentComposerDom,
} from "./index";
import { insertComposerSkillToken } from "./composer-skill-token";

const controllers: ComposerController[] = [];
const domParts: ReturnType<typeof createAgentComposerDom>[] = [];

// jsdom does not implement Range layout geometry. ProseMirror reads it via
// getClientRects when a transaction moves the selection (e.g. undo/redo scroll
// positioning), so provide the minimal stub the editor contract expects.
beforeEach(() => {
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({ top: 0, bottom: 0, left: 0, right: 0, height: 0, width: 0 }),
    },
  });
});

function setup() {
  const parts = createAgentComposerDom({
    t: (key) => key,
  });
  document.body.append(parts.composer);

  let persistedDraft: string | null = null;
  const draft = new ComposerDraftController({
    persistDelayMs: 0,
    persist: (value) => {
      persistedDraft = value;
    },
  });
  const controller = new ComposerController({
    input: parts.input,
    composer: parts.composer,
    initialDraft: "",
    draft,
    sendButtonRoot: createRoot(parts.sendButtonMount),
    inputDraftMaxChars: 500,
    getCurrentInputDraft: () => "",
    getUserHistoryMessages: () => [],
    getSendLabel: () => "Send",
    getSendButtonWantsStop: () => false,
    getHasAttachments: () => false,
    getHasPendingAttachments: () => false,
    submit: () => undefined,
    stop: () => undefined,
  });
  controllers.push(controller);
  domParts.push(parts);
  return {
    controller,
    draft,
    getPersistedDraft: () => persistedDraft,
  };
}

afterEach(() => {
  while (controllers.length > 0) controllers.pop()?.dispose();
  while (domParts.length > 0) disposeAgentComposerDom(domParts.pop()!);
  document.body.replaceChildren();
});

describe("ComposerController note references", () => {
  it("keeps boundary cursor navigation inside the nested composer", () => {
    const { controller } = setup();
    const editor = controller.editorInstance;
    editor.commands.setContent("重启", { contentType: "markdown" });
    editor.commands.focus("end");
    let parentKeydownCount = 0;
    const parentKeydown = () => {
      parentKeydownCount += 1;
    };
    const parent = controller.getInputElement().parentElement?.parentElement;
    parent?.addEventListener("keydown", parentKeydown);
    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    controller.getInputElement().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(parentKeydownCount).toBe(0);
    parent?.removeEventListener("keydown", parentKeydown);
  });

  it("blocks WebView control characters emitted by modified cursor keys", () => {
    const { controller } = setup();
    const editor = controller.editorInstance;
    editor.commands.setContent("重启", { contentType: "markdown" });
    editor.commands.focus("start");

    const event = new InputEvent("beforeinput", {
      inputType: "insertText",
      data: String.fromCharCode(0x1c),
      bubbles: true,
      cancelable: true,
    });
    controller.getInputElement().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(controller.getPrompt()).toBe("重启");
  });

  it("routes native select-all to the focused composer including rich text references", () => {
    const { controller } = setup();
    const editor = controller.editorInstance;
    editor.commands.setContent("first\nsecond", { contentType: "markdown" });
    controller.insertMemoReference({ notebookId: "notebook-a", relativePath: "reference.md", filename: "reference.md", title: "Reference" });
    const other = setup().controller;
    other.editorInstance.commands.setContent("other", { contentType: "markdown" });
    controller.focus();

    expect(invokeHandler("editor.selectAll")).toBe(true);
    expect(editor.state.selection.from).toBe(0);
    expect(editor.state.selection.to).toBe(editor.state.doc.content.size);
    expect(other.editorInstance.state.selection.empty).toBe(true);
    editor.commands.deleteSelection();
    expect(controller.getPrompt()).toBe("");
    expect(other.getPrompt()).toBe("other");
  });

  it("releases the select-all handler when the composer is disposed", () => {
    const { controller } = setup();
    controller.focus();
    expect(invokeHandler("editor.selectAll")).toBe(true);
    controller.dispose();
    expect(invokeHandler("editor.selectAll")).toBe(false);
  });

  it("routes native undo/redo to the focused composer", () => {
    const { controller } = setup();
    const view = controller.editorInstance.view;
    view.dispatch(view.state.tr.insertText("hello", 1));
    controller.focus();

    expect(controller.getPrompt()).toBe("hello");
    expect(invokeHandler("editor.undo")).toBe(true);
    expect(controller.getPrompt()).toBe("");
    expect(invokeHandler("editor.redo")).toBe(true);
    expect(controller.getPrompt()).toBe("hello");
  });

  it("keeps undo/redo scoped to the focused composer", () => {
    const { controller } = setup();
    const other = setup().controller;
    controller.editorInstance.view.dispatch(
      controller.editorInstance.view.state.tr.insertText("composer", 1),
    );
    other.editorInstance.view.dispatch(
      other.editorInstance.view.state.tr.insertText("other", 1),
    );
    controller.focus();

    expect(invokeHandler("editor.undo")).toBe(true);
    expect(controller.getPrompt()).toBe("");
    expect(other.getPrompt()).toBe("other");
  });

  it("releases the undo/redo handlers when the composer is disposed", () => {
    const { controller } = setup();
    const view = controller.editorInstance.view;
    view.dispatch(view.state.tr.insertText("hello", 1));
    controller.focus();
    expect(invokeHandler("editor.undo")).toBe(true);
    expect(invokeHandler("editor.redo")).toBe(true);
    controller.dispose();
    expect(invokeHandler("editor.undo")).toBe(false);
    expect(invokeHandler("editor.redo")).toBe(false);
  });

  it("focuses the Tiptap editor when clicking the input row", () => {
    const { controller } = setup();
    const row = controller
      .getInputElement()
      .parentElement;

    expect(row?.classList.contains("agent-thread-card__composer-input-row")).toBe(true);
    row?.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );

    expect(document.activeElement).toBe(controller.getInputElement());
    expect(controller.editorInstance.view.hasFocus()).toBe(true);
  });

  it("inserts a note card at the current cursor and persists its deep link", () => {
    const { controller, draft, getPersistedDraft } = setup();
    const editor = controller.editorInstance;

    editor.commands.setContent("before after", { contentType: "markdown" });
    editor.commands.setTextSelection(7);
    controller.insertMemoReference({
      filename: "reference.md",
      title: "Reference",
      notebookId: "notebook-a",
      relativePath: "reference.md",
    });
    draft.flush();

    expect(controller.getPrompt()).toBe(
      "before [Reference](flowix://open?notebookId=notebook-a&relativePath=reference.md) after",
    );
    expect(editor.getJSON().content?.[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "noteReference" }),
      ]),
    );
    expect(getPersistedDraft()).toBe(
      "before [Reference](flowix://open?notebookId=notebook-a&relativePath=reference.md) after",
    );
  });

  it("restores scoped DSH slash tokens as command prompt text", () => {
    const { controller } = setup();
    const editor = controller.editorInstance;
    editor.commands.setContent(
      "[/goal](flowix://slash/deepseek-harness/goal) define the milestone",
      { contentType: "markdown" },
    );
    expect(controller.getPrompt()).toBe("/goal define the milestone");

    editor.commands.setContent(
      "[/feedback](flowix://slash/feedback) ignored",
      { contentType: "markdown" },
    );
    expect(controller.getPrompt()).toBe(" ignored");
  });

  it("renders a Codex Skill card and restores its invocation syntax", () => {
    const { controller } = setup();
    const editor = controller.editorInstance;
    editor.commands.setContent(
      "[Browser](flowix://skill/codex/browser%3Acontrol-in-app-browser)",
      { contentType: "markdown" },
    );

    expect(controller.getInputElement().querySelector(".agent-thread-card__skill-token")?.textContent)
      .toBe("Browser");
    expect(controller.getPrompt()).toBe("$browser:control-in-app-browser");
    expect(editor.getMarkdown()).toBe(
      "[Browser](flowix://skill/codex/browser%3Acontrol-in-app-browser)",
    );
  });

  it("uses the qualified name suffix when a Skill has no display name", () => {
    const { controller } = setup();
    const editor = controller.editorInstance;
    editor.commands.setContent(
      "[control-in-app-browser](flowix://skill/codex/browser%3Acontrol-in-app-browser)",
      { contentType: "markdown" },
    );

    expect(controller.getInputElement().querySelector(".agent-thread-card__skill-token")?.textContent)
      .toBe("control-in-app-browser");
    expect(controller.getPrompt()).toBe("$browser:control-in-app-browser");
  });

  it("inserts a Skill card while keeping a complete Codex invocation", () => {
    const { controller } = setup();
    insertComposerSkillToken(
      controller.editorInstance,
      "browser:control-in-app-browser",
      "Browser",
    );

    expect(controller.getInputElement().querySelector(".agent-thread-card__skill-token")?.textContent)
      .toBe("Browser");
    expect(controller.getPrompt()).toBe("$browser:control-in-app-browser ");
  });
});

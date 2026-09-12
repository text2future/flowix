import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COMPOSER_SLASH_COMMANDS,
  ComposerSlashCommandController,
  formatCodexSkillDisplayName,
} from './composer-slash-command-controller';
import { ComposerSlashToken } from './composer-slash-token';

function setup(options: { onModelSelect?: () => void; onPermissionSelect?: () => void } = {}) {
  const composer = document.createElement('div');
  const input = document.createElement('div');
  input.contentEditable = 'true';
  composer.append(input);
  document.body.append(composer);
  vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({
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
    // Use the same mount contract as ComposerController. The input itself is
    // ProseMirror's root; the slash controller then moves that root into the
    // input row without introducing a nested editor.
    element: { mount: input },
    extensions: [StarterKit, Markdown, ComposerSlashToken],
    content: '',
    contentType: 'markdown',
  });
  const controller = new ComposerSlashCommandController({
    input,
    composer,
    editor,
    agentType: 'deepseek-harness',
    onModelSelect: options.onModelSelect,
    onPermissionSelect: options.onPermissionSelect,
  });
  return { composer, input, editor, controller };
}

function type(editor: Editor, value: string) {
  editor.commands.setContent(value, { contentType: 'markdown' });
  editor.commands.focus('end');
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('ComposerSlashCommandController', () => {
  it('removes the Codex namespace from fallback skill labels', () => {
    expect(formatCodexSkillDisplayName('$figma:figma-use')).toBe('figma-use');
    expect(formatCodexSkillDisplayName('browser:control-in-app-browser'))
      .toBe('control-in-app-browser');
  });

  it('focuses the Tiptap editor when the input row padding is pressed', () => {
    const { input, editor, controller } = setup();
    const row = input.parentElement;

    expect(row?.classList.contains('agent-thread-card__composer-input-row')).toBe(true);
    input.blur();
    row?.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    }));

    expect(document.activeElement).toBe(input);
    expect(editor.view.hasFocus()).toBe(true);
    controller.dispose();
    editor.destroy();
  });

  it('opens on slash and filters static commands', () => {
    const { editor, controller } = setup();
    type(editor, '/');
    expect([...document.querySelectorAll('.agent-composer-slash-menu__name')]
      .map((node) => node.textContent)).toEqual([
        '/compact', '/skill', '/goal', '/plan', '/model', '/permission', '/export',
      ]);
    expect([...document.querySelectorAll('.agent-composer-slash-menu__description')]
      .every((node) => !node.textContent?.endsWith('。'))).toBe(true);

    type(editor, '/pla');
    expect(document.querySelectorAll('.agent-composer-slash-menu__item')).toHaveLength(1);
    expect(document.querySelector('.agent-composer-slash-menu__name')?.textContent).toBe('/plan');
    controller.dispose();
  });

  it('keeps DSH ownership and interaction metadata on the slash catalog', () => {
    expect(COMPOSER_SLASH_COMMANDS.find((command) => command.name === 'compact')).toMatchObject({
      owner: 'dsh', interaction: 'direct', execution: 'dsh-command',
    });
    expect(COMPOSER_SLASH_COMMANDS.find((command) => command.name === 'skill')).toMatchObject({
      owner: 'dsh', interaction: 'drilldown', execution: 'dsh-skill',
    });
    expect(COMPOSER_SLASH_COMMANDS.find((command) => command.name === 'goal')).toMatchObject({
      owner: 'dsh', interaction: 'prompt', execution: 'dsh-command',
    });
    expect(COMPOSER_SLASH_COMMANDS.find((command) => command.name === 'model')).toMatchObject({
      owner: 'flowix', interaction: 'drilldown', execution: 'host-action',
    });
  });

  it('selects with Enter and removes the command as one unit', () => {
    const { input, composer, editor, controller } = setup();
    type(editor, '/goal');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(editor.getMarkdown()).toBe('[/goal](flowix://slash/deepseek-harness/goal)');
    expect(composer.querySelector('.agent-thread-card__slash-token')?.textContent).toBe('/goal');

    editor.commands.focus('start');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    expect(composer.querySelector('.agent-thread-card__slash-token')).toBeNull();
    controller.dispose();
    editor.destroy();
  });

  it('opens the permission settings callback and clears the input', () => {
    const onPermissionSelect = vi.fn();
    const { input, editor, controller } = setup({ onPermissionSelect });
    type(editor, '/permission');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(editor.getMarkdown()).toBe('');
    expect(document.querySelector('.agent-composer-slash-menu')).toBeNull();
    expect(onPermissionSelect).toHaveBeenCalledOnce();
    controller.dispose();
    editor.destroy();
  });

  it('opens the model settings callback for Codex and clears the input', () => {
    const onModelSelect = vi.fn();
    const composer = document.createElement('div');
    const input = document.createElement('div');
    composer.append(input);
    document.body.append(composer);
    const editor = new Editor({
      element: { mount: input },
      extensions: [StarterKit, Markdown, ComposerSlashToken],
      content: '',
      contentType: 'markdown',
    });
    const controller = new ComposerSlashCommandController({
      input,
      composer,
      editor,
      agentType: 'codex',
      onModelSelect,
    });
    type(editor, '/model');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(editor.getMarkdown()).toBe('');
    expect(document.querySelector('.agent-composer-slash-menu')).toBeNull();
    expect(onModelSelect).toHaveBeenCalledOnce();
    controller.dispose();
    editor.destroy();
  });

  it('shares selection between mouse movement and keyboard navigation', () => {
    const { input, editor, controller } = setup();
    type(editor, '/');

    const getItems = () => [...document.querySelectorAll<HTMLButtonElement>(
      '.agent-composer-slash-menu__item',
    )];
    const activeName = () => document.querySelector(
      '.agent-composer-slash-menu__item--active .agent-composer-slash-menu__name',
    )?.textContent;

    // A real mouse move selects the hovered command and exits keyboard mode.
    getItems()[3].dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      movementX: 4,
      movementY: 0,
    }));
    expect(activeName()).toBe('/plan');
    expect(document.querySelector('.agent-composer-slash-menu')?.classList.contains(
      'is-keyboard-navigation',
    )).toBe(false);

    // Keyboard navigation takes ownership of the shared active index.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(activeName()).toBe('/model');
    expect(document.querySelector('.agent-composer-slash-menu')?.classList.contains(
      'is-keyboard-navigation',
    )).toBe(true);

    // The stationary pointer must not take the selection back.
    getItems()[6].dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      movementX: 0,
      movementY: 0,
    }));
    expect(activeName()).toBe('/model');

    // Once the pointer really moves, hover selection is enabled again.
    getItems()[6].dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      movementX: 1,
      movementY: 0,
    }));
    expect(activeName()).toBe('/export');
    expect(document.querySelector('.agent-composer-slash-menu')?.classList.contains(
      'is-keyboard-navigation',
    )).toBe(false);
    controller.dispose();
    editor.destroy();
  });

  it('selects a command by mouse click', () => {
    const { editor, controller } = setup();
    type(editor, '/');
    const item = [...document.querySelectorAll<HTMLButtonElement>(
      '.agent-composer-slash-menu__item',
    )].find((candidate) => candidate.textContent?.includes('/goal'));
    item?.click();

    expect(editor.getMarkdown()).toBe('[/goal](flowix://slash/deepseek-harness/goal)');
    expect(document.querySelector('.agent-composer-slash-menu')).toBeNull();
    controller.dispose();
    editor.destroy();
  });

  it('round-trips the selected command through Markdown draft content', () => {
    const { composer, editor, controller } = setup();
    editor.commands.setContent('[/goal](flowix://slash/goal)', { contentType: 'markdown' });

    expect(editor.getMarkdown()).toBe('[/goal](flowix://slash/goal)');
    expect(composer.querySelector('.agent-thread-card__slash-token')?.textContent).toBe('/goal');

    controller.dispose();
    editor.destroy();
  });

  it('shows only Codex-supported commands in Codex composers', () => {
    const composer = document.createElement('div');
    const input = document.createElement('div');
    composer.append(input);
    document.body.append(composer);
    const editor = new Editor({
      element: { mount: input },
      extensions: [StarterKit, Markdown, ComposerSlashToken],
      content: '',
      contentType: 'markdown',
    });
    const controller = new ComposerSlashCommandController({
      input,
      composer,
      editor,
      agentType: 'codex',
    });
    type(editor, '/');
    expect([...document.querySelectorAll('.agent-composer-slash-menu__name')]
      .map((node) => node.textContent)).toEqual([
        '/compact', '/skill', '/goal', '/model', '/permission',
      ]);
    expect([...document.querySelectorAll('.agent-composer-slash-menu__name')]
      .map((node) => node.textContent)).not.toContain('/plan');
    expect([...document.querySelectorAll('.agent-composer-slash-menu__name')]
      .map((node) => node.textContent)).not.toContain('/export');
    expect(document.querySelector('.agent-composer-slash-menu')).not.toBeNull();
    controller.dispose();
    editor.destroy();
  });

  it('does not open for a composer without an Agent type', () => {
    const composer = document.createElement('div');
    const input = document.createElement('div');
    composer.append(input);
    document.body.append(composer);
    const editor = new Editor({
      element: { mount: input },
      extensions: [StarterKit, Markdown, ComposerSlashToken],
      content: '',
      contentType: 'markdown',
    });
    const controller = new ComposerSlashCommandController({
      input,
      composer,
      editor,
    });

    type(editor, '/');
    expect(document.querySelector('.agent-composer-slash-menu')).toBeNull();

    controller.dispose();
    editor.destroy();
  });

  it('opens the DSH skill submenu and inserts a scoped skill token', async () => {
    const { editor, controller } = setup();
    const listDshSkills = vi.fn(async () => [
      { name: 'review', description: 'Review the current change.' },
    ]);
    controller.dispose();
    editor.destroy();

    // Recreate with the callback because setup intentionally keeps its helper
    // focused on the static-menu path.
    const nextComposer = document.createElement('div');
    const nextInput = document.createElement('div');
    nextComposer.append(nextInput);
    document.body.append(nextComposer);
    const nextEditor = new Editor({
      element: { mount: nextInput },
      extensions: [StarterKit, Markdown, ComposerSlashToken],
      content: '',
      contentType: 'markdown',
    });
    const nextController = new ComposerSlashCommandController({
      input: nextInput,
      composer: nextComposer,
      editor: nextEditor,
      agentType: 'deepseek-harness',
      listDshSkills,
    });
    type(nextEditor, '/ski');
    nextInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    expect(listDshSkills).toHaveBeenCalledOnce();
    expect(document.querySelector('.agent-composer-slash-menu__name')?.textContent)
      .toBe('/review');
    expect(document.querySelector('.agent-composer-slash-menu__item--back')).not.toBeNull();
    expect(document.querySelector('.agent-composer-slash-menu__item--skill')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('.agent-composer-slash-menu__item:not(.agent-composer-slash-menu__item--back)')
      ?.click();
    expect(nextEditor.getMarkdown()).toBe('[/review](flowix://slash/deepseek-harness/review)');
    nextController.dispose();
    nextEditor.destroy();
  });

  it('closes for whitespace, no matches, Escape, and outside clicks', () => {
    const { input, editor, controller } = setup();
    type(editor, '/no-such-command');
    expect(document.querySelector('.agent-composer-slash-menu')).toBeNull();

    type(editor, '/goal now');
    expect(document.querySelector('.agent-composer-slash-menu')).toBeNull();

    type(editor, '/g');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.agent-composer-slash-menu')).toBeNull();

    type(editor, '/g');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(document.querySelector('.agent-composer-slash-menu')).toBeNull();
    controller.dispose();
    editor.destroy();
  });
});

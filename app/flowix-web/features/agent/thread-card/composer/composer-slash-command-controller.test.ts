import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { translate } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COMPOSER_SLASH_COMMANDS,
  ComposerSlashCommandController,
  formatCodexSkillDisplayName,
  type ComposerSlashCommand,
} from './composer-slash-command-controller';
import { ComposerSlashToken } from './composer-slash-token';
import { useAgentDataStore } from '@features/agent/store/agent-data-store';
import { notifyNotebookSkillsChanged } from '@features/agent/services/notebook-skills-events';
import { listCodexSkills } from '@features/agent/services/codex-slash-command-service';
import { agent } from '@platform/tauri/client/agent';
import { displayNameForComposerSkill } from './composer-skill-token';
import type { ComposerSlashSkill } from './composer-slash-command-controller';

function setup(options: {
  agentType?: 'dsh' | 'codex' | 'pi';
  getSkillsScopeId?: () => string;
  listDshSkills?: () => Promise<readonly ComposerSlashSkill[]>;
  listCodexSkills?: () => Promise<readonly ComposerSlashSkill[]>;
  listPiSkills?: () => Promise<readonly ComposerSlashSkill[]>;
  onModelSelect?: () => void;
  onPermissionSelect?: () => void;
  onDirectCommand?: (command: ComposerSlashCommand) => void;
  canExecuteCommand?: (command: ComposerSlashCommand) => boolean;
} = {}) {
  const composer = document.createElement('div');
  const input = document.createElement('div');
  input.contentEditable = 'true';
  const inputRow = document.createElement('div');
  inputRow.className = 'agent-composer__input-row';
  inputRow.append(input);
  composer.append(inputRow);
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
    // ProseMirror's root inside the factory-owned input row.
    element: { mount: input },
    extensions: [StarterKit, Markdown, ComposerSlashToken],
    content: '',
    contentType: 'markdown',
  });
  const controller = new ComposerSlashCommandController({
    input,
    composer,
    editor,
    agentType: options.agentType ?? 'dsh',
    getSkillsScopeId: options.getSkillsScopeId,
    listDshSkills: options.listDshSkills,
    listCodexSkills: options.listCodexSkills,
    listPiSkills: options.listPiSkills,
    onModelSelect: options.onModelSelect,
    onPermissionSelect: options.onPermissionSelect,
    onDirectCommand: options.onDirectCommand,
    canExecuteCommand: options.canExecuteCommand,
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
  it('keeps a direct command in the editor for the shared submission transaction', () => {
    const onDirectCommand = vi.fn();
    const { input, editor, controller } = setup({ onDirectCommand });
    type(editor, '/export');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onDirectCommand).toHaveBeenCalledWith(expect.objectContaining({ name: 'export' }));
    expect(editor.getMarkdown()).toContain('flowix://slash/dsh/export');
    controller.dispose();
    editor.destroy();
  });

  it('does not execute or clear a direct command that fails the submission guard', () => {
    const onDirectCommand = vi.fn();
    const { input, editor, controller } = setup({ onDirectCommand, canExecuteCommand: () => false });
    type(editor, '/export');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onDirectCommand).not.toHaveBeenCalled();
    expect(editor.getMarkdown()).toBe('/export');
    controller.dispose();
    editor.destroy();
  });

  it('removes the Codex namespace from fallback skill labels', () => {
    expect(formatCodexSkillDisplayName('$figma:figma-use')).toBe('figma-use');
    expect(formatCodexSkillDisplayName('browser:control-in-app-browser'))
      .toBe('control-in-app-browser');
  });

  it('preserves explicit display names containing colons or dollar signs', () => {
    expect(displayNameForComposerSkill('story-long-analyze', '小说:深度分析')).toBe('小说:深度分析');
    expect(displayNameForComposerSkill('pricing', '$Budget')).toBe('$Budget');
    expect(displayNameForComposerSkill('figma:figma-use', '  ')).toBe('figma-use');
  });

  it('focuses the Tiptap editor when the input row padding is pressed', () => {
    const { input, editor, controller } = setup();
    const row = input.parentElement;

    expect(row?.classList.contains('agent-composer__input-row')).toBe(true);
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
    // 菜单按当前界面语言展示标题（zh-CN），命令 id 不再直接呈现给用户。
    expect([...document.querySelectorAll('.agent-composer-slash-menu__name')]
      .map((node) => node.textContent)).toEqual([
        '压缩上下文', '目标', '计划模式', '模型', '权限', '导出',
      ]);
    expect([...document.querySelectorAll('.agent-composer-slash-menu__description')]
      .every((node) => !node.textContent?.endsWith('。'))).toBe(true);

    type(editor, '/pla');
    expect(document.querySelectorAll('.agent-composer-slash-menu__item')).toHaveLength(1);
    expect(document.querySelector('.agent-composer-slash-menu__name')?.textContent).toBe('计划模式');
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

    expect(editor.getMarkdown()).toBe('[/goal](flowix://slash/dsh/goal) ');
    expect(composer.querySelector('.agent-thread-card__slash-token')?.textContent).toBe(translate(getCurrentAppLanguage(), 'editor.threadCard.composer.longTask'));
    expect(composer.querySelector('.agent-thread-card__slash-token--control')).not.toBeNull();
    const wrapper = composer.querySelector('.agent-thread-card__slash-token-wrapper');
    expect(wrapper?.querySelectorAll('[data-inline-atom-card]')).toHaveLength(1);
    expect(wrapper?.firstChild?.textContent).toBe('\u200B');
    expect(wrapper?.lastChild?.textContent).toBe('\u200B');

    editor.commands.insertContent('继续输入');
    expect(editor.getMarkdown()).toBe('[/goal](flowix://slash/dsh/goal) 继续输入');

    editor.commands.focus('start');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    expect(composer.querySelector('.agent-thread-card__slash-token')).toBeNull();
    controller.dispose();
    editor.destroy();
  });

  it('keeps a Codex goal chip and the following text in the same paragraph', () => {
    const { input, editor, controller } = setup({ agentType: 'codex' });
    type(editor, '/goal');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    editor.commands.insertContent('继续描述目标');

    expect(editor.getMarkdown()).toBe('[/goal](flowix://slash/codex/goal) 继续描述目标');
    expect(editor.getJSON().content?.[0]?.type).toBe('paragraph');
    expect(editor.getJSON().content?.[0]?.content).toHaveLength(2);
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
    const inputRow = document.createElement('div');
  inputRow.className = 'agent-composer__input-row';
  inputRow.append(input);
  composer.append(inputRow);
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
    getItems()[2].dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      movementX: 4,
      movementY: 0,
    }));
    expect(activeName()).toBe('计划模式');
    expect(document.querySelector('.agent-composer-slash-menu')?.classList.contains(
      'is-keyboard-navigation',
    )).toBe(false);

    // Keyboard navigation takes ownership of the shared active index.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(activeName()).toBe('模型');
    expect(document.querySelector('.agent-composer-slash-menu')?.classList.contains(
      'is-keyboard-navigation',
    )).toBe(true);

    // The stationary pointer must not take the selection back.
    getItems()[5].dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      movementX: 0,
      movementY: 0,
    }));
    expect(activeName()).toBe('模型');

    // Once the pointer really moves, hover selection is enabled again.
    getItems()[5].dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      movementX: 1,
      movementY: 0,
    }));
    expect(activeName()).toBe('导出');
    expect(document.querySelector('.agent-composer-slash-menu')?.classList.contains(
      'is-keyboard-navigation',
    )).toBe(false);
    controller.dispose();
    editor.destroy();
  });

  it('selects a command by mouse click', () => {
    const { editor, controller } = setup();
    type(editor, '/');
    // 菜单按界面语言展示标题（zh-CN 为「目标」），不再包含命令名。
    const item = [...document.querySelectorAll<HTMLButtonElement>(
      '.agent-composer-slash-menu__item',
    )].find((candidate) => candidate.textContent?.includes('目标'));
    item?.click();

    expect(editor.getMarkdown()).toBe('[/goal](flowix://slash/dsh/goal) ');
    expect(document.querySelector('.agent-composer-slash-menu')).toBeNull();
    controller.dispose();
    editor.destroy();
  });

  it('round-trips the selected command through Markdown draft content', () => {
    const { composer, editor, controller } = setup();
    editor.commands.setContent('[/goal](flowix://slash/goal)', { contentType: 'markdown' });

    expect(editor.getMarkdown()).toBe('[/goal](flowix://slash/goal)');
    expect(composer.querySelector('.agent-thread-card__slash-token')?.textContent).toBe(translate(getCurrentAppLanguage(), 'editor.threadCard.composer.longTask'));

    controller.dispose();
    editor.destroy();
  });

  it('shows only Codex-supported commands in Codex composers', () => {
    const composer = document.createElement('div');
    const input = document.createElement('div');
    const inputRow = document.createElement('div');
  inputRow.className = 'agent-composer__input-row';
  inputRow.append(input);
  composer.append(inputRow);
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
        '压缩上下文', '目标', '计划模式', '模型', '权限',
      ]);
    expect([...document.querySelectorAll('.agent-composer-slash-menu__name')]
      .map((node) => node.textContent)).not.toContain('导出');
    expect(document.querySelector('.agent-composer-slash-menu')).not.toBeNull();
    controller.dispose();
    editor.destroy();
  });

  it('does not open for a composer without an Agent type', () => {
    const composer = document.createElement('div');
    const input = document.createElement('div');
    const inputRow = document.createElement('div');
  inputRow.className = 'agent-composer__input-row';
  inputRow.append(input);
  composer.append(inputRow);
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

  it('hides disabled Codex skills from the shared full catalog cache', async () => {
    const scope = 'codex-disabled-skill-cache';
    const store = useAgentDataStore.getState();
    store.setSkillCatalog('codex', scope, [
      { name: 'disabled-review', description: 'Disabled', enabled: false },
      { name: 'enabled-review', description: 'Enabled', enabled: true },
      { name: 'legacy-review', description: 'No enabled field' },
    ]);
    const listCodexSkills = vi.fn(async () => []);
    const { editor, controller } = setup({
      agentType: 'codex',
      getSkillsScopeId: () => scope,
      listCodexSkills,
    });
    const skillNames = () => [...document.querySelectorAll('.agent-composer-slash-menu__item--skill .agent-composer-slash-menu__name')]
      .map((node) => node.textContent);

    try {
      controller.openSlashMenu();
      expect(skillNames()).toEqual(['enabled-review', 'legacy-review']);
      await vi.waitFor(() => expect(document.querySelector('.agent-composer-slash-menu')?.getAttribute('aria-busy')).toBe('false'));
      expect(skillNames()).toEqual(['enabled-review', 'legacy-review']);
      expect(listCodexSkills).not.toHaveBeenCalled();
      expect(useAgentDataStore.getState().agents.codex.catalog.skillsByNotebookId[scope].items).toHaveLength(3);
    } finally {
      controller.dispose();
      editor.destroy();
    }
  });

  it('loads skills in the first-level menu', async () => {
    const { editor, controller } = setup();
    const listDshSkills = vi.fn(async () => [
      { name: 'review', description: 'Review the current change.', scope: 'repo' },
    ]);
    controller.dispose();
    editor.destroy();

    // Recreate with the callback because setup intentionally keeps its helper
    // focused on the static-menu path.
    const nextComposer = document.createElement('div');
    const nextInput = document.createElement('div');
    const nextRow = document.createElement('div');
    nextRow.className = 'agent-composer__input-row';
    nextRow.append(nextInput);
    nextComposer.append(nextRow);
    document.body.append(nextComposer);
    const nextEditor = new Editor({
      element: { mount: nextInput },
      extensions: [StarterKit, Markdown, ComposerSlashToken],
      content: '',
      contentType: 'markdown',
    });
    (nextEditor.view as unknown as { scrollToSelection: () => void }).scrollToSelection = () => undefined;
    const nextController = new ComposerSlashCommandController({
      input: nextInput,
      composer: nextComposer,
      editor: nextEditor,
      agentType: 'dsh',
      listDshSkills,
    });
    type(nextEditor, '/');
    await vi.waitFor(() => expect(listDshSkills).toHaveBeenCalledOnce());
    expect(listDshSkills).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect([...document.querySelectorAll('.agent-composer-slash-menu__name')]
      .map((node) => node.textContent)).toContain('review'));
    expect(document.querySelector('.agent-composer-slash-menu__item--skill')).not.toBeNull();
    expect(document.querySelector('.agent-composer-slash-menu__scope')?.textContent).toBe('项目');
    type(nextEditor, '');
    type(nextEditor, '/');
    await vi.waitFor(() => expect(document.querySelector('.agent-composer-slash-menu')?.getAttribute('aria-busy')).toBe('false'));
    expect(listDshSkills).toHaveBeenCalledOnce();
    useAgentDataStore.getState().invalidateSkillCatalog('dsh', 'global');
    type(nextEditor, '');
    type(nextEditor, '/');
    await vi.waitFor(() => expect(listDshSkills).toHaveBeenCalledTimes(2));
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


describe('slash picker asynchronous catalog lifecycle', () => {
  it.each(['slash', 'more'])('keeps project display-name through the %s menu data pipeline', async (entry) => {
    const root = '/notes/开发任务管理';
    vi.spyOn(agent, 'getCodexProjectSkills').mockResolvedValue({ skills: [{
      name: 'story-long-analyze', description: 'Analyze stories',
      path: `${root}/.agents/skills/story-long-analyze/SKILL.md`,
    }] });
    vi.spyOn(agent, 'readNotebookAgentSkills').mockResolvedValue([{
      id: 'story-long-analyze', name: '长篇小说拆文', enabled: true,
      description: 'Analyze stories', body: 'Instructions',
      path: '.agents/skills/story-long-analyze/SKILL.md',
      frontmatter: { name: 'story-long-analyze', 'display-name': '长篇小说拆文' },
    }]);
    const { editor, controller } = setup({
      agentType: 'codex', getSkillsScopeId: () => `project-display-name-${entry}`,
      listCodexSkills: () => listCodexSkills(root),
    });
    (editor.view as unknown as { scrollToSelection: () => void }).scrollToSelection = () => undefined;
    try {
      if (entry === 'slash') type(editor, '/');
      else controller.openSlashMenu();
      await vi.waitFor(() => expect(
        document.querySelector('.agent-composer-slash-menu__item--skill .agent-composer-slash-menu__name')?.textContent,
      ).toBe('长篇小说拆文'));
    } finally {
      controller.dispose();
      editor.destroy();
    }
  });

  it('does not let an in-flight pre-install request replace the installed catalog', async () => {
    const scope = 'install-during-skill-load';
    const pending = deferred();
    const listDshSkills = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce([{ name: 'installed-skill', description: 'Installed' }]);
    const { editor, controller } = setup({ getSkillsScopeId: () => scope, listDshSkills });
    try {
      controller.openSlashMenu();
      notifyNotebookSkillsChanged({ notebookId: scope, notebookPath: '/notebook' });
      pending.resolve([{ name: 'old-skill', description: 'Before install' }]);
      await vi.waitFor(() => expect(document.querySelector('.agent-composer-slash-menu')?.textContent).toContain('installed-skill'));
      expect(listDshSkills).toHaveBeenCalledTimes(2);
      expect(document.querySelector('.agent-composer-slash-menu')?.textContent).not.toContain('old-skill');
    } finally {
      controller.dispose();
      editor.destroy();
    }
  });

  it('reloads an open picker after installation invalidates a fresh catalog', async () => {
    const scope = 'installed-skill-refresh';
    useAgentDataStore.getState().setSkillCatalog('dsh', scope, [
      { name: 'existing-skill', description: 'Existing' },
    ]);
    const listDshSkills = vi.fn(async () => [
      { name: 'existing-skill', description: 'Existing' },
      { name: 'new-skill', displayName: '新安装技能', description: 'Installed' },
    ]);
    const { editor, controller } = setup({ getSkillsScopeId: () => scope, listDshSkills });
    try {
      controller.openSlashMenu();
      await vi.waitFor(() => expect(document.querySelector('.agent-composer-slash-menu')?.getAttribute('aria-busy')).toBe('false'));
      expect(listDshSkills).not.toHaveBeenCalled();
      notifyNotebookSkillsChanged({ notebookId: scope, notebookPath: '/notebook' });
      await vi.waitFor(() => expect(document.querySelector('.agent-composer-slash-menu')?.textContent).toContain('新安装技能'));
      expect(listDshSkills).toHaveBeenCalledOnce();
      expect(document.querySelector('.agent-composer-slash-menu')?.getAttribute('aria-busy')).toBe('false');
    } finally {
      controller.dispose();
      editor.destroy();
    }
  });

  function deferred() {
    let resolve!: (skills: readonly ComposerSlashSkill[]) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<readonly ComposerSlashSkill[]>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  it('shows cached skills and loading immediately, preserving keyboard selection on completion', async () => {
    const scope = 'review-cached-loading';
    const store = useAgentDataStore.getState();
    store.setSkillCatalog('dsh', scope, [{ name: 'cached-review', description: 'Cached skill' }]);
    store.invalidateSkillCatalog('dsh', scope);
    const request = deferred();
    const { editor, controller, input } = setup({
      getSkillsScopeId: () => scope,
      listDshSkills: () => request.promise,
    });
    try {
      controller.openSlashMenu();
      expect(document.querySelector('.agent-composer-slash-menu')?.textContent).toContain('cached-review');
      expect(document.querySelector('.agent-composer-slash-menu [role="listbox"]')?.firstElementChild?.getAttribute('role')).toBe('status');
      expect(document.querySelector('.agent-composer-slash-menu')?.textContent).toContain('正在加载 Skill');
      expect(document.querySelector('.agent-composer-slash-menu')?.getAttribute('aria-busy')).toBe('true');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const selected = document.querySelector('[aria-selected="true"]')?.textContent;
      request.resolve([{ name: 'fresh-review', description: 'Fresh skill' }]);
      await vi.waitFor(() => expect(document.querySelector('.agent-composer-slash-menu')?.textContent).toContain('fresh-review'));
      expect(document.querySelector('[aria-selected="true"]')?.textContent).toBe(selected);
      expect(document.querySelector('.agent-composer-slash-menu')?.getAttribute('aria-busy')).toBe('false');
      expect(editor.getMarkdown()).toBe('');
    } finally {
      controller.dispose();
      editor.destroy();
    }
  });

  it('ignores an old notebook response and completes the new notebook request', async () => {
    let scope = 'review-scope-a';
    const first = deferred();
    const second = deferred();
    const { editor, controller } = setup({
      agentType: 'pi', getSkillsScopeId: () => scope,
      listPiSkills: () => scope.endsWith('-a') ? first.promise : second.promise,
    });
    try {
      controller.openSlashMenu();
      scope = 'review-scope-b';
      controller.refresh();
      first.resolve([{ name: 'old-notebook', description: 'Old' }]);
      await Promise.resolve();
      expect(document.querySelector('.agent-composer-slash-menu')?.textContent).not.toContain('old-notebook');
      second.resolve([{ name: 'new-notebook', description: 'New' }]);
      await vi.waitFor(() => expect(document.querySelector('.agent-composer-slash-menu')?.textContent).toContain('new-notebook'));
    } finally {
      controller.dispose();
      editor.destroy();
    }
  });

  it('shows a load failure even when the agent has no static commands', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const request = deferred();
    const { editor, controller } = setup({
      agentType: 'pi', getSkillsScopeId: () => 'review-empty-error', listPiSkills: () => request.promise,
    });
    try {
      controller.openSlashMenu();
      request.reject(new Error('catalog unavailable'));
      await vi.waitFor(() => expect(document.querySelector('.agent-composer-slash-menu')?.textContent).toContain('加载失败'));
    } finally {
      controller.dispose();
      editor.destroy();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import type { I18nKey } from '@features/i18n';

import Frontmatter from './frontmatter';
import {
  createFrontmatterValueControl,
  createFrontmatterValueDisplay,
  inferFrontmatterPropertyKind,
} from './frontmatter-inline-value';
import {
  FrontmatterPropertyError,
  formatFrontmatterPropertyValue,
  parseVisibleFrontmatter,
  replaceVisibleFrontmatterProperties,
  updateVisibleFrontmatterProperty,
} from '@features/document/properties/frontmatter-model';
import { generatePropertyKey } from '@features/document/properties/property-key';

describe('frontmatter property helpers', () => {
  it('skips the system key and returns every property from the first group', () => {
    const result = parseVisibleFrontmatter('key: ra61em97\nstatus: in-progress\nkeywords: [推广, 归类]');

    expect(result.firstProperty).toEqual({ key: 'status', value: 'in-progress' });
    expect(result.properties).toEqual([
      { key: 'status', value: 'in-progress' },
      { key: 'keywords', value: ['推广', '归类'] },
    ]);
    expect(result.userData).toEqual({
      status: 'in-progress',
      keywords: ['推广', '归类'],
    });
  });

  it('returns an empty visible property when frontmatter only has the system key', () => {
    const result = parseVisibleFrontmatter('key: ra61em97');

    expect(result.firstProperty).toBeNull();
    expect(result.parseError).toBeNull();
  });

  it('updates the first property in place and preserves later properties and comments', () => {
    const result = updateVisibleFrontmatterProperty(
      'key: ra61em97\n# workflow state\nstatus: todo\nkeywords: [推广, 归类]',
      'status',
      'stage',
      'in-progress',
    );

    expect(result).toContain('# workflow state');
    expect(result).toContain('stage: in-progress');
    expect(result).toContain('keywords: [ 推广, 归类 ]');
    expect(parseVisibleFrontmatter(result).userData).toEqual({
      stage: 'in-progress',
      keywords: ['推广', '归类'],
    });
  });

  it('adds a first user property after the system key', () => {
    const result = updateVisibleFrontmatterProperty(
      'key: ra61em97',
      null,
      'status',
      'todo',
    );

    expect(result).toBe('key: ra61em97\nstatus: todo');
    expect(parseVisibleFrontmatter(result).userData).toEqual({ status: 'todo' });
  });

  it('rejects editing the system key', () => {
    expect(() => updateVisibleFrontmatterProperty(
      'key: ra61em97',
      null,
      'key',
      'another-id',
    )).toThrow(/managed by Flowix/);
  });

  it('formats collections as a compact single line', () => {
    expect(formatFrontmatterPropertyValue(['推广', '归类'])).toBe('[ 推广, 归类 ]');
  });

  it('keeps text-looking values as strings and validates numeric properties', () => {
    const text = updateVisibleFrontmatterProperty(
      'key: ra61em97\ncode: old',
      'code',
      'code',
      '0123',
      'Text',
    );
    expect(parseVisibleFrontmatter(text).userData.code).toBe('0123');

    expect(() => updateVisibleFrontmatterProperty(
      'key: ra61em97\nscore: 1',
      'score',
      'score',
      'not-a-number',
      'Number',
    )).toThrow(FrontmatterPropertyError);
  });

  it('normalizes document tags and rejects invalid membership values', () => {
    const next = updateVisibleFrontmatterProperty(
      'key: ra61em97',
      null,
      'tags',
      'work/path, work/path, 中文',
      'MultiSelect',
    );
    expect(parseVisibleFrontmatter(next).userData.tags).toEqual(['work/path', '中文']);

    expect(() => updateVisibleFrontmatterProperty(
      'key: ra61em97',
      null,
      'tags',
      'has space',
      'MultiSelect',
    )).toThrow(/Tags cannot contain/);
    expect(() => replaceVisibleFrontmatterProperties(
      '---\nkey: ra61em97\n---\nBody',
      [{ key: 'tags', value: 'not-an-array' }],
    )).toThrow(/Tags must be a list/);
  });

  it('canonicalizes the singular tag key to tags', () => {
    expect(generatePropertyKey('tag')).toBe('tags');
    const next = updateVisibleFrontmatterProperty(
      'key: ra61em97\ntag: [legacy]',
      'tag',
      'tag',
      'legacy, current',
      'MultiSelect',
    );
    expect(next).toContain('tags:');
    expect(next).not.toContain('\ntag:');
    expect(parseVisibleFrontmatter(next).userData.tags).toEqual(['legacy', 'current']);
  });

  it('preserves system metadata and comments when dialog properties are saved', () => {
    const content = [
      '---',
      'key: ra61em97',
      '# workflow state',
      'status: todo',
      'keywords: [one, two]',
      '---',
      '# Body',
    ].join('\n');
    const next = replaceVisibleFrontmatterProperties(content, [
      { key: 'status', value: 'done' },
    ]);

    expect(next).toContain('key: ra61em97');
    expect(next).toContain('# workflow state');
    expect(next).toContain('status: done');
    expect(next).not.toContain('keywords:');
    expect(next).toContain('# Body');
  });

  it('renders and edits typed inline property values', () => {
    const t = (key: I18nKey) => String(key);

    const icon = createFrontmatterValueDisplay({
      value: 'avocado',
      text: 'avocado',
      kind: 'Icon',
      t,
    });
    const iconImage = icon.querySelector<HTMLImageElement>('.frontmatter-property__value-icon');
    expect(iconImage).not.toBeNull();
    expect(iconImage?.title).toBe('Avocado');

    const tags = createFrontmatterValueDisplay({
      value: ['推广', '归类'],
      text: '[ 推广, 归类 ]',
      kind: 'MultiSelect',
      t,
    });
    expect(tags.querySelectorAll('.frontmatter-property__value-chip')).toHaveLength(2);
    expect(tags.textContent).toBe('推广归类');

    expect(inferFrontmatterPropertyKind(42)).toBe('Number');
    expect(inferFrontmatterPropertyKind('2026-07-21')).toBe('Date');
    expect(inferFrontmatterPropertyKind('https://example.com')).toBe('URL');

    const changed: string[] = [];
    const date = createFrontmatterValueControl({
      value: '2026-07-21',
      kind: 'Date',
      t,
      onChange: (value) => changed.push(value),
      onKeyDown: () => undefined,
    });
    expect((date.dom as HTMLInputElement).type).toBe('date');

    const iconPicker = createFrontmatterValueControl({
      value: 'avocado',
      kind: 'Icon',
      t,
      onChange: (value) => changed.push(value),
      onKeyDown: () => undefined,
    });
    iconPicker.dom.querySelector<HTMLButtonElement>('.frontmatter-property__value-trigger')?.click();
    const nextIcon = iconPicker.dom.querySelectorAll<HTMLButtonElement>(
      '.frontmatter-property__icon-option',
    )[1];
    nextIcon?.click();
    expect(changed[changed.length - 1]).toBe(nextIcon?.dataset.value);

    const tagPicker = createFrontmatterValueControl({
      value: 'existing',
      kind: 'MultiSelect',
      options: ['existing', 'work/path'],
      t,
      onChange: (value) => changed.push(value),
      onKeyDown: () => undefined,
    });
    document.body.append(tagPicker.dom);
    tagPicker.focus();
    const suggestedTag = tagPicker.dom.querySelector<HTMLButtonElement>(
      '.frontmatter-property__value-option[data-value="work/path"]',
    );
    expect(suggestedTag).not.toBeNull();
    suggestedTag?.click();
    expect(changed[changed.length - 1]).toBe('existing, work/path');
    tagPicker.dom.remove();
  });

  it('renders the first configured property through the real Tiptap node view', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [
        StarterKit,
        Markdown,
        Frontmatter,
      ],
      content: [
        '---',
        'key: 8c7dxu0l',
        'type: prompt',
        'status: todo',
        'keywords: [推广, 归类]',
        'priority: high',
        '---',
        '# 2026-07-21',
        '',
        '---',
        'body-property: ignored',
        '---',
      ].join('\n'),
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(editor.state.doc.firstChild?.type.name).toBe('frontmatter');
    const displayedKeys = [...host.querySelectorAll('.frontmatter-property__key')]
      .map((element) => element.textContent);
    const displayedValues = [...host.querySelectorAll('.frontmatter-property__value')]
      .map((element) => element.textContent);
    expect(displayedKeys).toEqual(['类型', '状态', '关键词', 'priority']);
    expect(displayedValues).toEqual(['提示词', '待处理', '推广归类', 'high']);
    expect(host.querySelector('.frontmatter-property__separator')).toBeNull();
    expect(host.querySelector('.frontmatter-property__edit-icon')).toBeNull();
    expect(editor.state.doc.content.content.filter((node) => node.type.name === 'frontmatter')).toHaveLength(1);
    const addPropertyButton = host.querySelector<HTMLButtonElement>(
      '.frontmatter-property__add-property',
    );
    expect(host.querySelectorAll('.frontmatter-property__display')).toHaveLength(4);
    expect(addPropertyButton).not.toBeNull();
    expect(addPropertyButton?.parentElement?.classList.contains(
      'frontmatter-property__tags',
    )).toBe(true);
    expect(addPropertyButton?.previousElementSibling?.classList.contains(
      'frontmatter-property__tag-add',
    )).toBe(true);
    expect(host.querySelector('.frontmatter-property__toggle')).toBeNull();

    host.querySelector<HTMLButtonElement>(
      '.frontmatter-property__display[data-key="status"] '
      + '.frontmatter-property__display-key',
    )?.click();
    const keyTrigger = host.querySelector<HTMLButtonElement>('.frontmatter-property__key-trigger');
    const valueTrigger = host.querySelector<HTMLButtonElement>('.frontmatter-property__value-trigger');
    expect(host.querySelector('.frontmatter-property__editor')).not.toBeNull();
    expect(keyTrigger).not.toBeNull();
    expect(valueTrigger).not.toBeNull();
    expect(host.querySelector('.frontmatter-property__value-input')).toBeNull();
    expect(keyTrigger?.tagName).toBe('BUTTON');
    const keyMenu = host.querySelector<HTMLElement>('.frontmatter-property__key-menu');
    const keyOptions = [...host.querySelectorAll<HTMLButtonElement>('.frontmatter-property__key-option')];
    expect(keyMenu?.hidden).toBe(false);
    expect(keyOptions.map((option) => option.dataset.key)).toContain('status');
    expect(keyMenu?.querySelector('optgroup')).toBeNull();
    const addedType = keyMenu?.querySelector<HTMLButtonElement>(
      '.frontmatter-property__key-option[data-key="type"]',
    );
    expect(addedType?.disabled).toBe(true);
    expect(addedType?.querySelector('.frontmatter-property__key-option-added')?.textContent)
      .toBe('已添加');
    const selectedCheck = keyMenu?.querySelector(
      '.frontmatter-property__key-option[aria-selected="true"] '
      + '.frontmatter-property__key-option-check svg',
    );
    expect(selectedCheck?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(selectedCheck?.querySelector('path')?.getAttribute('d')).toBe('M20 6 9 17l-5-5');
    expect(host.querySelector('.frontmatter-property__action')).toBeNull();
    host.querySelector<HTMLButtonElement>(
      '.frontmatter-property__key-option[data-key="status"]',
    )?.click();
    const rerenderedValueTrigger = host.querySelector<HTMLButtonElement>(
      '.frontmatter-property__value-trigger',
    );
    rerenderedValueTrigger?.click();
    host.querySelector<HTMLButtonElement>(
      '.frontmatter-property__value-option[data-value="done"]',
    )?.click();
    const otherDocumentBlock = document.createElement('p');
    otherDocumentBlock.tabIndex = -1;
    document.body.append(otherDocumentBlock);
    otherDocumentBlock.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    otherDocumentBlock.focus();

    expect(host.querySelector('.frontmatter-property__editor')).toBeNull();
    expect(editor.getMarkdown()).toContain('status: done');
    expect([...host.querySelectorAll('.frontmatter-property__value')].map(
      (element) => element.textContent,
    )).toEqual(['提示词', '已完成', '推广归类', 'high']);

    host.querySelector<HTMLButtonElement>(
      '.frontmatter-property__display[data-key="status"] '
      + '.frontmatter-property__display-value',
    )?.click();
    expect(host.querySelector<HTMLElement>('.frontmatter-property__value-menu')?.hidden)
      .toBe(false);
    otherDocumentBlock.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    otherDocumentBlock.focus();
    expect(host.querySelector('.frontmatter-property__editor')).toBeNull();

    host.querySelector<HTMLButtonElement>('.frontmatter-property__add-property')?.click();
    const markdownBeforeBlankProperty = editor.getMarkdown();
    const addEditor = host.querySelector('.frontmatter-property__editor');
    expect(addEditor).not.toBeNull();
    expect(host.querySelector('.frontmatter-property__add-property')).not.toBeNull();
    expect(addEditor?.previousElementSibling?.classList.contains(
      'frontmatter-property__tags',
    )).toBe(true);
    otherDocumentBlock.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(host.querySelector('.frontmatter-property__editor')).toBeNull();
    expect(host.querySelector('.frontmatter-property__validation')).toBeNull();
    expect(host.querySelector('.frontmatter-property__add-property')).not.toBeNull();
    expect(editor.getMarkdown()).toBe(markdownBeforeBlankProperty);

    editor.destroy();
    otherDocumentBlock.remove();
    host.remove();
  });

  it('keeps the add-property editor open after picking a key from the dropdown', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nkey: 8c7dxu0l\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    host.querySelector<HTMLButtonElement>('.frontmatter-property__add-property')?.click();
    expect(host.querySelector('.frontmatter-property__editor')).not.toBeNull();
    expect(host.querySelector<HTMLElement>('.frontmatter-property__key-menu')?.hidden)
      .toBe(false);

    host.querySelector<HTMLButtonElement>(
      '.frontmatter-property__key-option[data-key="status"]',
    )?.click();

    // The editor must stay open with the chosen key committed to the trigger,
    // not auto-cancel as if the property were still empty.
    expect(host.querySelector('.frontmatter-property__editor')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>(
      '.frontmatter-property__key-trigger-label',
    )?.textContent).toBe('状态');
    expect(host.querySelector('.frontmatter-property__value-trigger')).not.toBeNull();
    expect(editor.getMarkdown()).not.toContain('status:');

    editor.destroy();
    host.remove();
  });

  it('does not commit when a re-render evicts the focused key option (webkit removal focusout)', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nkey: 8c7dxu0l\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    host.querySelector<HTMLButtonElement>('.frontmatter-property__add-property')?.click();
    // Capture the editor element that owns the currently-focused key option,
    // before picking a key re-renders and detaches it.
    const previousEditor = host.querySelector<HTMLElement>('.frontmatter-property__editor');
    expect(previousEditor).not.toBeNull();

    host.querySelector<HTMLButtonElement>(
      '.frontmatter-property__key-option[data-key="status"]',
    )?.click();

    // WebKit fires a `focusout` on the detached previous editor when the
    // focused key option is removed by the re-render. relatedTarget can be
    // null OR document.body (focus briefly lands on body before the new value
    // control is focused). Either way this must NOT be treated as the user
    // leaving the editor.
    previousEditor!.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }),
    );
    previousEditor!.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: null }),
    );
    await Promise.resolve();

    expect(host.querySelector('.frontmatter-property__editor')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>(
      '.frontmatter-property__key-trigger-label',
    )?.textContent).toBe('状态');
    expect(editor.getMarkdown()).not.toContain('status:');

    editor.destroy();
    host.remove();
  });

  it('activates empty text and multiselect values from the value column', async () => {
    const host = document.createElement('div');
    const outside = document.createElement('button');
    document.body.append(host, outside);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nkey: 8c7dxu0l\nsummary: ""\nkeywords: []\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    host.querySelector<HTMLButtonElement>(
      '.frontmatter-property__display[data-key="summary"] '
      + '.frontmatter-property__display-value',
    )?.click();
    const textInput = host.querySelector<HTMLInputElement>(
      '.frontmatter-property__value-input',
    );
    expect(textInput).not.toBeNull();
    expect(document.activeElement).toBe(textInput);

    outside.focus();
    host.querySelector<HTMLButtonElement>(
      '.frontmatter-property__display[data-key="keywords"] '
      + '.frontmatter-property__display-value',
    )?.click();
    const multiInput = host.querySelector<HTMLInputElement>(
      '.frontmatter-property__multi-input',
    );
    expect(multiInput).not.toBeNull();
    expect(document.activeElement).toBe(multiInput);

    editor.destroy();
    outside.remove();
    host.remove();
  });

  it('renders tags as a standalone wrapping strip and appends from its trailing control', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nkey: 8c7dxu0l\ntags: [alpha, beta]\nstatus: todo\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect([...host.querySelectorAll('.frontmatter-property__key')]
      .map((element) => element.textContent)).toEqual(['状态']);
    expect([...host.querySelectorAll('.frontmatter-property__tag-label')]
      .map((element) => element.textContent)).toEqual(['alpha', 'beta']);
    const addButton = host.querySelector<HTMLButtonElement>('.frontmatter-property__tag-add');
    expect(addButton).not.toBeNull();
    expect(addButton?.textContent).toBe('添加标签');
    addButton?.click();

    const input = host.querySelector<HTMLInputElement>('.frontmatter-property__tag-input');
    expect(input).not.toBeNull();
    if (input) {
      input.value = 'gamma';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }

    expect([...host.querySelectorAll('.frontmatter-property__tag-label')]
      .map((element) => element.textContent)).toEqual(['alpha', 'beta', 'gamma']);
    expect(editor.getMarkdown()).toContain('tags:');
    expect(editor.getMarkdown()).toContain('- gamma');

    editor.destroy();
    host.remove();
  });

  it('shows the tag add control and creates tags when the property is absent', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nkey: 8c7dxu0l\nstatus: todo\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const addButton = host.querySelector<HTMLButtonElement>('.frontmatter-property__tag-add');
    expect(addButton).not.toBeNull();
    expect(addButton?.textContent).toBe('添加标签');
    addButton?.click();

    const input = host.querySelector<HTMLInputElement>('.frontmatter-property__tag-input');
    expect(input).not.toBeNull();
    if (input) {
      input.value = 'newtag';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }

    expect(editor.getMarkdown()).toContain('tags:');
    expect(editor.getMarkdown()).toContain('- newtag');
    expect([...host.querySelectorAll('.frontmatter-property__tag-label')]
      .map((element) => element.textContent)).toEqual(['newtag']);

    editor.destroy();
    host.remove();
  });
});

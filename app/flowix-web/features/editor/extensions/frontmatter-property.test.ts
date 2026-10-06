import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';

import Frontmatter from './frontmatter';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import {
  FrontmatterPropertyError,
  extractFrontmatter,
  formatFrontmatterPropertyValue,
  parseVisibleFrontmatter,
  reorderVisibleFrontmatterProperty,
  replaceVisibleFrontmatterProperties,
  suggestFrontmatterRepair,
  updateVisibleFrontmatterProperty,
} from '@features/document/properties/frontmatter-model';
import { generatePropertyKey } from '@features/document/properties/property-key';
import { resolvePropertyType } from '@features/document/properties/property-type';

describe('frontmatter property helpers', () => {
  it('resolves fixed, preset, and inferred property types from one source', () => {
    expect(resolvePropertyType('name', ['Demo'])).toEqual({
      kind: 'Text',
      displayKind: 'text',
    });
    expect(resolvePropertyType('tags', 'alpha')).toEqual({
      kind: 'Tags',
      displayKind: 'array',
    });
    expect(resolvePropertyType('status', 'todo')).toEqual({
      kind: 'Text',
      displayKind: 'text',
    });
    expect(resolvePropertyType('type', 'custom')).toEqual({
      kind: 'Text',
      displayKind: 'text',
    });
    expect(resolvePropertyType('ref-url', 'https://example.com')).toEqual({
      kind: 'URL',
      displayKind: 'url',
    });
    expect(resolvePropertyType('languages', ['Rust'])).toEqual({
      kind: 'MultiSelect',
      displayKind: 'array',
    });
    expect(resolvePropertyType('enabled', false)).toEqual({
      kind: 'Boolean',
      displayKind: 'boolean',
    });
  });

  it('reorders visible properties while keeping the system key in place', () => {
    const yaml = 'flowix_key: ra61em97\nfirst: one\nsecond: two\nthird: three';
    const reordered = reorderVisibleFrontmatterProperty(yaml, 'first', 'third', 'after');
    expect([...parseVisibleFrontmatter(reordered).properties].map(({ key }) => key))
      .toEqual(['second', 'third', 'first']);
    expect(reordered.indexOf('flowix_key: ra61em97'))
      .toBeLessThan(reordered.indexOf('second: two'));
  });

  it('consumes a legacy BOM displaced behind frontmatter', () => {
    const editor = new Editor({
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: abc12345\n---\n\uFEFFBody',
      contentType: 'markdown',
    });

    const markdown = editor.getMarkdown();
    expect(markdown).toContain('flowix_key: abc12345');
    expect(markdown).toContain('Body');
    expect(markdown).not.toContain('\uFEFF');
    expect(markdown).not.toContain('nbsp');
    editor.destroy();
  });

  it('parses frontmatter after leading blank lines', () => {
    const content = '\n  \n---\nflowix_key: abc12345\nstatus: draft\n---\n# Body';
    const extracted = extractFrontmatter(content);
    expect(extracted.hasFrontmatter).toBe(true);
    expect(extracted.userData).toEqual({ status: 'draft' });
    expect(extracted.body).toBe('# Body');

    const editor = new Editor({
      extensions: [StarterKit, Markdown, Frontmatter],
      content,
      contentType: 'markdown',
    });
    expect(editor.state.doc.firstChild?.type.name).toBe('frontmatter');
    expect(editor.state.doc.firstChild?.attrs.yamlContent).toBe(
      'flowix_key: abc12345\nstatus: draft',
    );
    editor.destroy();
  });

  it('skips the system key and returns every property from the first group', () => {
    const result = parseVisibleFrontmatter('flowix_key: ra61em97\nstatus: in-progress\nkeywords: [推广, 归类]');

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
    const result = parseVisibleFrontmatter('flowix_key: ra61em97');

    expect(result.firstProperty).toBeNull();
    expect(result.parseError).toBeNull();
  });

  it('hides the deprecated legacy key from visible properties', () => {
    const result = parseVisibleFrontmatter('key: legacy-id\nstatus: draft');

    expect(result.properties).toEqual([{ key: 'status', value: 'draft' }]);
    expect(result.userData).toEqual({ status: 'draft' });
  });

  it('suggests moving the malformed suffix into the document body', () => {
    const repair = suggestFrontmatterRepair(
      'flowix_key: db9ixhlw\nname: "skill\\n"\n  skill\nflowix_colors: [green]',
    );

    expect(repair).toEqual({
      yamlContent: 'flowix_key: db9ixhlw\nname: "skill\\n"',
      bodyContent: '  skill\nflowix_colors: [green]',
    });
    expect(parseVisibleFrontmatter(repair?.yamlContent ?? '').parseError).toBeNull();
  });

  it('repairs malformed frontmatter from the error banner', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: db9ixhlw\nname: "skill\\n"\n  skill\nflowix_colors: [green]\n---\n# Body',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const repair = host.querySelector<HTMLButtonElement>('.frontmatter-property__repair');
    expect(repair).not.toBeNull();
    repair?.click();

    expect(editor.state.doc.firstChild?.attrs.yamlContent).toBe(
      'flowix_key: db9ixhlw\nname: "skill\\n"',
    );
    expect(editor.state.doc.child(1).type.name).toBe('codeBlock');
    expect(editor.state.doc.child(1).textContent).toBe('  skill\nflowix_colors: [green]');
    expect(editor.getMarkdown()).toContain('flowix_colors: [green]');

    editor.destroy();
    host.remove();
  });

  it('updates the first property in place and preserves later properties and comments', () => {
    const result = updateVisibleFrontmatterProperty(
      'flowix_key: ra61em97\n# workflow state\nstatus: todo\nkeywords: [推广, 归类]',
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
      'flowix_key: ra61em97',
      null,
      'status',
      'todo',
    );

    expect(result).toBe('flowix_key: ra61em97\nstatus: todo');
    expect(parseVisibleFrontmatter(result).userData).toEqual({ status: 'todo' });
  });

  it('rejects editing the system key', () => {
    expect(() => updateVisibleFrontmatterProperty(
      'flowix_key: ra61em97',
      null,
      'key',
      'another-id',
    )).toThrow(/managed by Flowix/);
  });

  it('formats collections as a compact single line', () => {
    expect(formatFrontmatterPropertyValue(['推广', '归类'])).toBe('[ 推广, 归类 ]');
  });

  it('keeps long property text intact for the display layer', () => {
    const value = 'A relentless interview to sharpen a plan or design.'.repeat(3);

    expect(formatFrontmatterPropertyValue(value, Number.POSITIVE_INFINITY)).toBe(value);
  });

  it('keeps text-looking values as strings and validates numeric properties', () => {
    const text = updateVisibleFrontmatterProperty(
      'flowix_key: ra61em97\ncode: old',
      'code',
      'code',
      '0123',
      'Text',
    );
    expect(parseVisibleFrontmatter(text).userData.code).toBe('0123');

    expect(() => updateVisibleFrontmatterProperty(
      'flowix_key: ra61em97\nscore: 1',
      'score',
      'score',
      'not-a-number',
      'Number',
    )).toThrow(FrontmatterPropertyError);
  });

  it('normalizes document tags and rejects invalid membership values', () => {
    const next = updateVisibleFrontmatterProperty(
      'flowix_key: ra61em97',
      null,
      'tags',
      '#work/path, work/path, 中文',
      'MultiSelect',
    );
    expect(parseVisibleFrontmatter(next).userData.tags).toEqual(['work/path', '中文']);

    expect(() => updateVisibleFrontmatterProperty(
      'flowix_key: ra61em97',
      null,
      'tags',
      'has space',
      'MultiSelect',
    )).toThrow(/Tags cannot contain/);
    expect(() => replaceVisibleFrontmatterProperties(
      '---\nflowix_key: ra61em97\n---\nBody',
      [{ key: 'tags', value: 'not-an-array' }],
    )).toThrow(/Tags must be a list/);

    const customTags = replaceVisibleFrontmatterProperties(
      '---\nflowix_key: ra61em97\n---\nBody',
      [{ key: 'topics', value: ['#work/path', 'work/path', '中文'], kind: 'Tags' }],
    );
    expect(extractFrontmatter(customTags).userData.topics)
      .toEqual(['work/path', '中文']);

    const genericTags = replaceVisibleFrontmatterProperties(
      '---\nflowix_key: ra61em97\n---\nBody',
      [{ key: 'keywords', value: ['#work', '带 空格'], kind: 'Tag' }],
    );
    expect(extractFrontmatter(genericTags).userData.keywords)
      .toEqual(['#work', '带 空格']);
  });

  it('uses the Flowix product palette for internal note colors', () => {
    const next = updateVisibleFrontmatterProperty(
      'flowix_key: ra61em97',
      null,
      'flowix_colors',
      'blue, red',
      'MultiSelect',
    );
    expect(parseVisibleFrontmatter(next).userData.flowix_colors)
      .toEqual(['red', 'blue']);

    expect(() => updateVisibleFrontmatterProperty(
      'flowix_key: ra61em97',
      null,
      'flowix_colors',
      'purple',
      'MultiSelect',
    )).toThrow(/product color palette/);

    const customColor = replaceVisibleFrontmatterProperties(
      '---\nflowix_key: ra61em97\n---\nBody',
      [{ key: 'accent', value: ['blue', 'red'], kind: 'Color' }],
    );
    expect(extractFrontmatter(customColor).userData.accent)
      .toEqual(['red', 'blue']);
  });

  it('renders the Flowix color palette for flowix_colors values', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: ra61em97\nflowix_colors: [blue]\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const colorValue = host.querySelector<HTMLElement>(
      '[data-property-key="flowix_colors"] .frontmatter-property__display-value',
    );
    expect(colorValue?.querySelectorAll('.frontmatter-property__value-color-dot')).toHaveLength(1);
    expect(colorValue?.querySelector('.frontmatter-property__value-color-dot')?.getAttribute('data-value'))
      .toBe('blue');
    expect(colorValue?.querySelector('.frontmatter-property__value-chip')).toBeNull();
    expect(colorValue?.querySelector('.frontmatter-property__value-color-dot')?.getAttribute('role'))
      .toBe('img');
    host.querySelector<HTMLElement>(
      '[data-property-key="flowix_colors"] .frontmatter-property__display-value',
    )?.click();
    const popover = document.body.querySelector<HTMLElement>('.frontmatter-property__edit-popover');
    const colors = popover?.querySelectorAll<HTMLButtonElement>(
      '.frontmatter-property__edit-color-option',
    ) ?? [];
    expect(colors).toHaveLength(7);
    expect(colors[0]?.dataset.value).toBe('red');
    expect(colors[5]?.getAttribute('aria-pressed')).toBe('true');

    colors[0]?.click();
    popover?.querySelector<HTMLElement>('.frontmatter-property__edit-colors')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ctrlKey: true }),
    );
    expect(parseVisibleFrontmatter(
      String(editor.state.doc.firstChild?.attrs.yamlContent ?? ''),
    ).userData.flowix_colors).toEqual(['red', 'blue']);

    editor.destroy();
    host.remove();
  });

  it('localizes built-in property keys without changing their stored keys', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: ra61em97\nflowix_colors: [blue]\ntags: [work]\nflowix_icon: smile\nname: Demo\ndescription: Note\nflowix_favorited: true\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect([...host.querySelectorAll('.frontmatter-property__key')]
      .map((element) => element.textContent)).toEqual(['颜色', '标签', '图标', '名称', '描述', '置顶']);
    expect(host.querySelector('[data-property-key="flowix_colors"]')).not.toBeNull();
    expect(host.querySelector('[data-property-key="tags"]')).not.toBeNull();
    expect(host.querySelector('[data-property-key="flowix_icon"]')).not.toBeNull();
    expect(host.querySelector('[data-property-key="name"]')).not.toBeNull();
    expect(host.querySelector('[data-property-key="description"]')).not.toBeNull();
    expect(host.querySelector('[data-property-key="flowix_favorited"]')).not.toBeNull();
    expect(host.querySelector('[data-property-key="name"] .frontmatter-property__type-icon')
      ?.classList.contains('frontmatter-property__type-icon--text')).toBe(true);
    expect(host.querySelector('[data-property-key="tags"] .frontmatter-property__type-icon')
      ?.classList.contains('frontmatter-property__type-icon--array')).toBe(true);
    expect(host.querySelector('[data-property-key="flowix_colors"] .frontmatter-property__type-icon')
      ?.classList.contains('frontmatter-property__type-icon--color')).toBe(true);
    expect(editor.getMarkdown()).toContain('flowix_colors: [blue]');
    expect(editor.getMarkdown()).toContain('tags: [work]');
    expect(editor.getMarkdown()).toContain('flowix_icon: smile');
    expect(editor.getMarkdown()).toContain('name: Demo');
    expect(editor.getMarkdown()).toContain('description: Note');
    expect(editor.getMarkdown()).toContain('flowix_favorited: true');

    const fixedPropertyKinds = [
      ['name', '文本'],
      ['description', '文本'],
      ['tags', '笔记标签'],
      ['flowix_colors', '颜色'],
      ['flowix_icon', '图标'],
    ] as const;
    fixedPropertyKinds.forEach(([key, label]) => {
      host.querySelector<HTMLElement>(
        `[data-property-key="${key}"] .frontmatter-property__display-value`,
      )?.click();
      const popover = document.body.querySelector<HTMLElement>('.frontmatter-property__edit-popover');
      const typeTrigger = popover?.querySelector<HTMLButtonElement>('.frontmatter-property__edit-type-trigger');
      expect(typeTrigger?.disabled).toBe(true);
      expect(typeTrigger?.querySelector('.frontmatter-property__edit-type-label')?.textContent)
        .toBe(`${label}（预设属性不可修改）`);
      if (key === 'flowix_icon') {
        expect(popover?.querySelector('.frontmatter-property__edit-icon-chevron')).toBeNull();
        expect(popover?.querySelector('.frontmatter-property__edit-icon-box')).not.toBeNull();
        expect(popover?.querySelector('.frontmatter-property__edit-icon-box--empty')).not.toBeNull();
        expect(popover?.querySelector('.frontmatter-property__edit-icon-placeholder')).not.toBeNull();
        const clear = popover?.querySelector<HTMLElement>('.frontmatter-property__edit-icon-clear');
        expect(clear?.getAttribute('aria-label')).toBe('清空图标');
        clear?.click();
        expect(popover?.querySelector('.frontmatter-property__edit-icon-menu')?.getAttribute('hidden'))
          .not.toBeNull();
      }
    });

    editor.destroy();
    host.remove();
  });

  it('keeps the name property text icon when its YAML value is a sequence', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: ra61em97\nname: [Demo]\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const icon = host.querySelector('[data-property-key="name"] .frontmatter-property__type-icon');
    expect(icon?.classList.contains('frontmatter-property__type-icon--text')).toBe(true);
    expect(icon?.classList.contains('frontmatter-property__type-icon--array')).toBe(false);

    editor.destroy();
    host.remove();
  });

  it('renders Select values as directly togglable checkboxes', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: ra61em97\nenabled: false\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const getCheckbox = () => host.querySelector<HTMLInputElement>(
      '[data-property-key="enabled"] .frontmatter-property__value-checkbox',
    );
    let checkbox = getCheckbox();
    expect(checkbox?.type).toBe('checkbox');
    expect(checkbox?.checked).toBe(false);
    expect(checkbox?.getAttribute('data-property-type')).toBe('Select');

    checkbox?.click();
    expect(parseVisibleFrontmatter(
      String(editor.state.doc.firstChild?.attrs.yamlContent ?? ''),
    ).userData.enabled).toBe(true);

    checkbox = getCheckbox();
    checkbox?.click();
    expect(parseVisibleFrontmatter(
      String(editor.state.doc.firstChild?.attrs.yamlContent ?? ''),
    ).userData.enabled).toBe(false);
    expect(document.body.querySelector('.frontmatter-property__edit-popover')).toBeNull();

    editor.destroy();
    host.remove();
  });

  it('canonicalizes the singular tag key to tags', async () => {
    expect(await generatePropertyKey('tag')).toBe('tags');
    const next = updateVisibleFrontmatterProperty(
      'flowix_key: ra61em97\ntag: [legacy]',
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
      'flowix_key: ra61em97',
      '# workflow state',
      'status: todo',
      'keywords: [one, two]',
      '---',
      '# Body',
    ].join('\n');
    const next = replaceVisibleFrontmatterProperties(content, [
      { key: 'status', value: 'done' },
    ]);

    expect(next).toContain('flowix_key: ra61em97');
    expect(next).toContain('# workflow state');
    expect(next).toContain('status: done');
    expect(next).not.toContain('keywords:');
    expect(next).toContain('# Body');
  });

  it('renders every visible frontmatter property while preserving YAML properties', async () => {
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
        'flowix_key: 8c7dxu0l',
        'tags: [alpha, beta]',
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
    expect(host.querySelector('.frontmatter-property__heading-label')).toBeNull();
    expect(host.querySelector('.frontmatter-property__heading-icon')).toBeNull();
    expect([...host.querySelectorAll('.frontmatter-property__key')]
      .map((element) => element.textContent)).toEqual([
        '标签',
        'type',
        'status',
        'keywords',
        'priority',
      ]);
    expect([...host.querySelectorAll('[data-property-key="tags"] .frontmatter-property__value-chip')]
      .map((element) => element.textContent)).toEqual(['#alpha', '#beta']);
    expect([...host.querySelectorAll('[data-property-key="tags"] .frontmatter-property__value-chip')]
      .every((element) => element.classList.contains('tag-node'))).toBe(true);
    expect(host.querySelector('.frontmatter-property__tag-add')).toBeNull();
    expect(host.querySelector('.frontmatter-property__add-property')).toBeNull();
    expect(host.querySelectorAll('.frontmatter-property__display')).toHaveLength(5);
    expect(host.querySelector('.frontmatter-property__editor')).toBeNull();

    const markdown = editor.getMarkdown();
    expect(markdown).toContain('type: prompt');
    expect(markdown).toContain('status: todo');
    expect(markdown).toContain('keywords: [推广, 归类]');
    expect(markdown).toContain('priority: high');

    editor.destroy();
    host.remove();
  });

  it('opens an aligned overlay editor and saves the changed property value', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: 8c7dxu0l\ndescription: Before\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const row = host.querySelector<HTMLElement>('[data-property-key="description"]');
    expect(row).not.toBeNull();
    row?.querySelector<HTMLElement>('.frontmatter-property__display-value')?.click();

    const popover = document.body.querySelector<HTMLElement>(
      '.frontmatter-property__edit-popover',
    );
    const input = popover?.querySelector<HTMLTextAreaElement>(
      '.frontmatter-property__edit-input',
    );
    const typeTrigger = popover?.querySelector<HTMLButtonElement>(
      '.frontmatter-property__edit-type-trigger',
    );
    expect(popover?.style.position).toBe('fixed');
    expect(popover?.style.left).toBe('0px');
    expect(popover?.style.top).toBe('0px');
    expect(input?.value).toBe('Before');
    expect(typeTrigger?.querySelector('.frontmatter-property__edit-type-label')?.textContent)
      .toBe('文本（预设属性不可修改）');
    expect([...popover?.querySelectorAll<HTMLElement>(
      '.frontmatter-property__edit-type-option',
    ) ?? []].map((option) => option.textContent)).toEqual([
      '文本',
      '是否',
      '数字',
      '日期',
      '单选',
      '多选',
      '标签',
      '笔记标签',
      '颜色',
      '图标',
    ]);
    typeTrigger?.focus();
    await Promise.resolve();
    expect(document.body.contains(popover ?? null)).toBe(true);
    input?.focus();

    if (input) {
      input.value = 'After';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        ctrlKey: true,
      }));
    }

    expect(editor.getMarkdown()).toContain('description: After');
    expect(document.body.querySelector('.frontmatter-property__edit-popover')).toBeNull();

    editor.destroy();
    host.remove();
  });

  it('renders YAML arrays with the multi-select editor', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: 8c7dxu0l\nlanguages:\n  - JavaScript\n  - TypeScript\n  - Rust\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const row = host.querySelector<HTMLElement>('[data-property-key="languages"]');
    expect(row?.querySelectorAll('.frontmatter-property__value-chip')).toHaveLength(3);
    expect([...row?.querySelectorAll('.frontmatter-property__value-chip') ?? []]
      .map((item) => item.textContent)).toEqual(['JavaScript', 'TypeScript', 'Rust']);

    row?.querySelector<HTMLElement>('.frontmatter-property__display-value')?.click();
    const popover = document.body.querySelector<HTMLElement>('.frontmatter-property__edit-popover');
    expect(popover?.querySelectorAll('.frontmatter-property__edit-tag-chip')).toHaveLength(3);
    expect(popover?.querySelector('.frontmatter-property__edit-list-input')).toBeNull();

    editor.destroy();
    host.remove();
  });

  it('opens a separate key editor and preserves the property value', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: 8c7dxu0l\ndescription: Before\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const row = host.querySelector<HTMLElement>('[data-property-key="description"]');
    const keyCell = row?.querySelector<HTMLElement>('.frontmatter-property__display-key');
    expect(keyCell).not.toBeNull();
    keyCell?.click();

    const popover = document.body.querySelector<HTMLElement>(
      '.frontmatter-property__edit-popover',
    );
    const input = popover?.querySelector<HTMLInputElement>(
      '.frontmatter-property__edit-input',
    );
    expect(input?.tagName).toBe('INPUT');
    expect(input?.value).toBe('description');
    expect(popover?.querySelector('.frontmatter-property__edit-type-trigger')).toBeNull();

    expect(popover?.querySelector('.frontmatter-property__edit-key-trigger')).toBeNull();
    expect(popover?.querySelector('.frontmatter-property__edit-key-menu')).toBeNull();

    if (input) {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.value = '名称';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }));
      expect(editor.getMarkdown()).toContain('description: Before');
      expect(document.body.querySelector('.frontmatter-property__edit-popover')).not.toBeNull();
      input.dispatchEvent(new CompositionEvent('compositionend', {
        bubbles: true,
        data: '名称',
      }));

      input.value = 'summary';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
      }));
    }

    expect(editor.getMarkdown()).toContain('summary: Before');
    expect(editor.getMarkdown()).not.toContain('description:');
    expect(document.body.querySelector('.frontmatter-property__edit-popover')).toBeNull();

    editor.destroy();
    host.remove();
  });

  it('opens property actions from the type icon and moves or deletes the whole row', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: 8c7dxu0l\nstatus: todo\npriority: high\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const statusIcon = host.querySelector<HTMLElement>(
      '[data-property-key="status"] .frontmatter-property__type-icon',
    );
    statusIcon?.click();
    const menu = document.body.querySelector<HTMLElement>('.frontmatter-property__item-menu');
    expect(menu).not.toBeNull();
    expect([...menu?.querySelectorAll<HTMLButtonElement>('.frontmatter-property__item-menu-button') ?? []]
      .map((button) => button.textContent)).toEqual(['预设', '上移', '下移', '删除属性']);
    expect(menu?.querySelector<HTMLButtonElement>('.frontmatter-property__item-menu-button')?.disabled)
      .toBe(false);

    const presetButton = menu?.querySelector<HTMLButtonElement>('.frontmatter-property__preset-button');
    presetButton?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    const presetMenu = menu?.querySelector<HTMLElement>('.frontmatter-property__preset-menu');
    expect(presetMenu).not.toBeNull();
    expect([...presetMenu?.querySelectorAll<HTMLButtonElement>('.frontmatter-property__edit-key-option') ?? []]
      .map((option) => option.textContent)).toEqual(['名称', '描述', '标签', '颜色', '图标']);

    menu?.querySelectorAll<HTMLButtonElement>('.frontmatter-property__item-menu-button')[2]?.click();
    expect([...host.querySelectorAll('.frontmatter-property__key')]
      .map((element) => element.textContent)).toEqual(['priority', 'status']);
    const movedMarkdown = editor.getMarkdown();
    expect(movedMarkdown.indexOf('priority: high'))
      .toBeLessThan(movedMarkdown.indexOf('status: todo'));

    host.querySelector<HTMLElement>(
      '[data-property-key="status"] .frontmatter-property__type-icon',
    )?.click();
    const movedMenu = document.body.querySelector<HTMLElement>('.frontmatter-property__item-menu');
    expect(movedMenu?.querySelectorAll<HTMLButtonElement>('.frontmatter-property__item-menu-button')[2]?.disabled)
      .toBe(true);
    movedMenu?.querySelector<HTMLButtonElement>('.frontmatter-property__item-menu-button:last-child')?.click();

    expect([...host.querySelectorAll('.frontmatter-property__key')]
      .map((element) => element.textContent)).toEqual(['priority']);
    expect(editor.getMarkdown()).toContain('priority: high');
    expect(editor.getMarkdown()).not.toContain('status: todo');
    expect(editor.getMarkdown()).toContain('Body');

    editor.destroy();
    host.remove();
  });

  it('applies a common preset from the property actions submenu', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: 8c7dxu0l\npriority: high\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    host.querySelector<HTMLElement>(
      '[data-property-key="priority"] .frontmatter-property__type-icon',
    )?.click();
    const menu = document.body.querySelector<HTMLElement>('.frontmatter-property__item-menu');
    const presetItem = menu?.querySelector<HTMLElement>('.frontmatter-property__preset-item');
    presetItem?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    menu?.querySelector<HTMLButtonElement>(
      '.frontmatter-property__preset-menu [data-value="name"]',
    )?.click();

    expect(host.querySelector('[data-property-key="name"]')).not.toBeNull();
    expect(editor.getMarkdown()).toContain('name: high');
    expect(editor.getMarkdown()).not.toContain('priority:');

    editor.destroy();
    host.remove();
  });

  it('marks occupied presets inert with an explanatory tooltip', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: 8c7dxu0l\nstatus: todo\ntags:\n  - a\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    host.querySelector<HTMLElement>(
      '[data-property-key="status"] .frontmatter-property__type-icon',
    )?.click();
    const menu = document.body.querySelector<HTMLElement>('.frontmatter-property__item-menu');
    menu?.querySelector<HTMLElement>('.frontmatter-property__preset-item')
      ?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    const presetMenu = menu?.querySelector<HTMLElement>('.frontmatter-property__preset-menu');

    const tags = presetMenu?.querySelector<HTMLButtonElement>('[data-value="tags"]');
    expect(tags?.disabled).toBe(true);
    expect(tags?.getAttribute('aria-disabled')).toBe('true');
    expect(tags?.title).toBe('该属性已存在');

    const name = presetMenu?.querySelector<HTMLButtonElement>('[data-value="name"]');
    expect(name?.disabled).toBe(false);
    expect(name?.getAttribute('aria-disabled')).toBeNull();

    editor.destroy();
    host.remove();
  });

  it('treats the row’s own key as occupied in its preset list', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: 8c7dxu0l\ntags:\n  - a\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    host.querySelector<HTMLElement>(
      '[data-property-key="tags"] .frontmatter-property__type-icon',
    )?.click();
    const menu = document.body.querySelector<HTMLElement>('.frontmatter-property__item-menu');
    menu?.querySelector<HTMLElement>('.frontmatter-property__preset-item')
      ?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    const presetMenu = menu?.querySelector<HTMLElement>('.frontmatter-property__preset-menu');

    // The row's own preset cannot be applied again, so it is inert too.
    const tags = presetMenu?.querySelector<HTMLButtonElement>('[data-value="tags"]');
    expect(tags?.disabled).toBe(true);
    expect(tags?.title).toBe('该属性已存在');

    // Clicking it must not rewrite the document.
    tags?.click();
    expect(editor.getMarkdown()).toContain('tags:\n  - a');
    expect(host.querySelector('[data-property-key="tags"]')).not.toBeNull();

    editor.destroy();
    host.remove();
  });

  it('keeps a custom field key in the tooltip when the preset is occupied', async () => {
    // Custom presets come from user settings. Seed them synchronously through
    // `setState` and always restore: leaving them behind would leak custom
    // presets into every later test in this file.
    const store = useUserSettingsStore.getState();
    const previousFields = store.settings.properties.fields;
    useUserSettingsStore.setState({
      settings: {
        ...store.settings,
        properties: {
          ...store.settings.properties,
          fields: [
            { key: 'status', type: 'Text' },
            { key: 'owner', type: 'Text' },
          ],
        },
      },
    });

    const host = document.createElement('div');
    document.body.append(host);
    let editor: Editor | undefined;
    try {
      editor = new Editor({
        element: host,
        extensions: [StarterKit, Markdown, Frontmatter],
        content: '---\nflowix_key: 8c7dxu0l\nstatus: todo\npriority: high\n---\nBody',
        contentType: 'markdown',
      });

      await new Promise((resolve) => window.setTimeout(resolve, 0));

      host.querySelector<HTMLElement>(
        '[data-property-key="priority"] .frontmatter-property__type-icon',
      )?.click();
      const menu = document.body.querySelector<HTMLElement>('.frontmatter-property__item-menu');
      menu?.querySelector<HTMLElement>('.frontmatter-property__preset-item')
        ?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      const presetMenu = menu?.querySelector<HTMLElement>('.frontmatter-property__preset-menu');

      // The disabled row must still name the field it refers to, not only the
      // conflict reason.
      const status = presetMenu?.querySelector<HTMLButtonElement>('[data-value="status"]');
      expect(status?.disabled).toBe(true);
      expect(status?.title).toBe('status · 该属性已存在');

      const owner = presetMenu?.querySelector<HTMLButtonElement>('[data-value="owner"]');
      expect(owner?.disabled).toBe(false);
      expect(owner?.title).toBe('owner');
    } finally {
      editor?.destroy();
      host.remove();
      const current = useUserSettingsStore.getState().settings;
      useUserSettingsStore.setState({
        settings: { ...current, properties: { ...current.properties, fields: previousFields } },
      });
    }
  });

  it('does not opt into the browser native drag lifecycle', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: 8c7dxu0l\nstatus: todo\npriority: high\ncategory: work\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const source = host.querySelector<HTMLElement>('[data-property-key="status"]');
    const target = host.querySelector<HTMLElement>('[data-property-key="category"]');
    expect(source?.draggable).toBe(false);
    expect(source?.querySelector<HTMLElement>('.frontmatter-property__type-icon')?.draggable)
      .toBe(false);
    expect(target).not.toBeNull();

    expect([...host.querySelectorAll('.frontmatter-property__key')]
      .map((element) => element.textContent)).toEqual(['status', 'priority', 'category']);

    editor.destroy();
    host.remove();
  });

  it('reorders property rows from a pointer drag that starts on the type icon', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: 8c7dxu0l\nstatus: todo\npriority: high\ncategory: work\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const source = host.querySelector<HTMLElement>('[data-property-key="status"]');
    const sourceIcon = source?.querySelector<HTMLElement>('.frontmatter-property__type-icon');
    const target = host.querySelector<HTMLElement>('[data-property-key="category"]');
    expect(sourceIcon).not.toBeNull();
    expect(target).not.toBeNull();

    const dispatchPointerEvent = (targetElement: EventTarget, type: string, init: Record<string, number>) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.entries({ pointerId: 1, button: 0, clientX: 0, clientY: 0, ...init })
        .forEach(([key, value]) => Object.defineProperty(event, key, { value }));
      targetElement.dispatchEvent(event);
    };

    dispatchPointerEvent(sourceIcon as HTMLElement, 'pointerdown', { clientX: 0, clientY: 0 });
    dispatchPointerEvent(window, 'pointermove', { clientX: 10, clientY: 10 });
    expect(document.documentElement.classList.contains('frontmatter-property--dragging')).toBe(true);
    const selectStart = new Event('selectstart', { bubbles: true, cancelable: true });
    document.dispatchEvent(selectStart);
    expect(selectStart.defaultPrevented).toBe(true);
    expect(document.body.querySelector('.frontmatter-property__drag-preview')).not.toBeNull();
    const placeholder = host.querySelector<HTMLElement>(
      '.frontmatter-property__display--drag-placeholder',
    );
    expect(placeholder).not.toBeNull();
    expect(placeholder?.getAttribute('aria-hidden')).toBe('true');
    expect(placeholder?.previousElementSibling).toBe(target);
    expect(source?.isConnected).toBe(false);
    dispatchPointerEvent(window, 'pointermove', { clientX: 10, clientY: 10 });
    expect(host.querySelector('.frontmatter-property__display--drag-placeholder')).toBe(placeholder);
    dispatchPointerEvent(window, 'pointerup', { clientX: 10, clientY: 10 });
    expect(host.querySelector('.frontmatter-property__display--drag-placeholder')).toBeNull();
    expect(document.body.querySelector('.frontmatter-property__drag-preview')).toBeNull();
    expect(document.documentElement.classList.contains('frontmatter-property--dragging')).toBe(false);

    expect([...host.querySelectorAll('.frontmatter-property__key')]
      .map((element) => element.textContent)).toEqual(['priority', 'category', 'status']);

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    host.querySelector<HTMLElement>(
      '[data-property-key="status"] .frontmatter-property__type-icon',
    )?.click();
    expect(document.body.querySelector('.frontmatter-property__item-menu')).not.toBeNull();

    editor.destroy();
    host.remove();
  });

  it('converts a value when its editor type changes', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: 8c7dxu0l\nscore: "42"\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    host.querySelector<HTMLElement>(
      '[data-property-key="score"] .frontmatter-property__display-value',
    )?.click();
    const popover = document.body.querySelector<HTMLElement>(
      '.frontmatter-property__edit-popover',
    );
    const typeTrigger = popover?.querySelector<HTMLButtonElement>(
      '.frontmatter-property__edit-type-trigger',
    );
    expect(typeTrigger?.querySelector('.frontmatter-property__edit-type-label')?.textContent)
      .toBe('文本');

    if (typeTrigger) {
      typeTrigger.click();
      popover?.querySelector<HTMLButtonElement>(
        '.frontmatter-property__edit-type-option[data-value="Number"]',
      )?.click();
      const numberInput = popover?.querySelector<HTMLInputElement>(
        '.frontmatter-property__edit-input',
      );
      expect(numberInput?.type).toBe('number');
      expect(popover?.querySelectorAll('.frontmatter-property__edit-number-step'))
        .toHaveLength(2);
      if (numberInput) {
        numberInput.value = '-42';
        numberInput.dispatchEvent(new Event('input', { bubbles: true }));
        numberInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: '.',
          bubbles: true,
        }));
        expect(numberInput.value).toBe('-42');
        popover?.querySelector<HTMLButtonElement>(
          '.frontmatter-property__edit-number-step:first-child',
        )?.click();
        expect(numberInput.value).toBe('-41');
        popover?.querySelector<HTMLButtonElement>(
          '.frontmatter-property__edit-number-step:last-child',
        )?.click();
        expect(numberInput.value).toBe('-42');
        numberInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          ctrlKey: true,
        }));
      }
    }

    const yamlContent = String(editor.state.doc.firstChild?.attrs.yamlContent ?? '');
    expect(parseVisibleFrontmatter(yamlContent).userData.score).toBe(-42);

    editor.destroy();
    host.remove();
  });

  it('renders date and checkbox controls for custom value types', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: 8c7dxu0l\nlabels:\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const openValueEditor = () => {
      host.querySelector<HTMLElement>(
        '[data-property-key="labels"] .frontmatter-property__display-value',
      )?.click();
      return document.body.querySelector<HTMLElement>('.frontmatter-property__edit-popover');
    };
    const selectType = (popover: HTMLElement, type: 'Date' | 'Boolean') => {
      popover.querySelector<HTMLButtonElement>('.frontmatter-property__edit-type-trigger')?.click();
      popover.querySelector<HTMLButtonElement>(
        `.frontmatter-property__edit-type-option[data-value="${type}"]`,
      )?.click();
    };

    let popover = openValueEditor();
    expect(popover?.querySelector<HTMLTextAreaElement>('.frontmatter-property__edit-input'))
      .not.toBeNull();
    if (popover) selectType(popover, 'Date');
    await Promise.resolve();
    const dateButton = popover?.querySelector<HTMLButtonElement>(
      '.frontmatter-property__date-picker-trigger',
    );
    expect(dateButton).not.toBeNull();
    dateButton?.click();
    await Promise.resolve();
    const datePicker = document.body.querySelector<HTMLElement>(
      '.frontmatter-property__date-picker-popover',
    );
    expect(datePicker).not.toBeNull();
    expect(datePicker?.textContent).not.toContain('{year}');
    expect(datePicker?.textContent).not.toContain('{month}');
    expect(datePicker?.textContent).toMatch(/\d{4}/);
    datePicker?.querySelector<HTMLButtonElement>('[data-date="2026-09-13"]')?.click();
    dateButton?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      ctrlKey: true,
    }));
    let yamlContent = String(editor.state.doc.firstChild?.attrs.yamlContent ?? '');
    expect(parseVisibleFrontmatter(yamlContent).userData.labels).toBe('2026-09-13');

    popover = openValueEditor();
    if (popover) selectType(popover, 'Boolean');
    const checkbox = popover?.querySelector<HTMLInputElement>('.frontmatter-property__edit-checkbox');
    expect(checkbox?.type).toBe('checkbox');
    if (checkbox) {
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      checkbox.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        ctrlKey: true,
      }));
    }
    yamlContent = String(editor.state.doc.firstChild?.attrs.yamlContent ?? '');
    expect(parseVisibleFrontmatter(yamlContent).userData.labels).toBe(true);

    editor.destroy();
    host.remove();
  });

  it('uses the not-set fallback for an empty tag array', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: 8c7dxu0l\ntags: []\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const value = host.querySelector<HTMLElement>(
      '[data-property-key="tags"] .frontmatter-property__display-value',
    );
    expect(value?.textContent).toBe('未设置');
    expect(value?.textContent).not.toContain('[]');

    editor.destroy();
    host.remove();
  });

  it('edits the tags key through the same multi-select editor as a tag property', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: 8c7dxu0l\ntags: [alpha, beta]\nstatus: todo\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect([...host.querySelectorAll('.frontmatter-property__key')]
      .map((element) => element.textContent)).toEqual(['标签', 'status']);
    expect(host.querySelector('.frontmatter-property__add-property')).toBeNull();
    expect(host.querySelector('.frontmatter-property__tag-add')).toBeNull();
    expect(host.querySelector('.frontmatter-property__display-value')?.textContent)
      .toContain('alpha');

    const valueCell = host.querySelector<HTMLElement>(
      '[data-property-key="tags"] .frontmatter-property__display-value',
    );
    valueCell?.click();
    const popover = document.body.querySelector<HTMLElement>('.frontmatter-property__edit-popover');
    expect(popover?.querySelector('.frontmatter-property__edit-type-label')?.textContent)
      .toBe('笔记标签（预设属性不可修改）');
    const input = popover?.querySelector<HTMLInputElement>('.frontmatter-property__edit-tags-input');
    expect(input).not.toBeNull();
    expect(popover?.querySelector('.frontmatter-property__edit-tag-remove')).toBeNull();
    if (input) {
      input.value = '#候选';
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }));
      expect(popover?.querySelectorAll('.frontmatter-property__edit-tag-chip')).toHaveLength(2);
      input.dispatchEvent(new CompositionEvent('compositionend', {
        bubbles: true,
        data: '候选',
      }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(popover?.querySelectorAll('.frontmatter-property__edit-tag-chip')).toHaveLength(3);
      input.value = '';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));

      input.value = '#gammaLongTag';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const chips = popover?.querySelectorAll('.frontmatter-property__edit-tag-chip') ?? [];
      expect(chips[chips.length - 1]?.textContent)
        .toContain('gammaLongTag');
      expect(chips[chips.length - 1]?.textContent)
        .toContain('#');
      expect(chips[chips.length - 1]?.classList.contains('frontmatter-property__edit-tag-chip--plain'))
        .toBe(false);
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        ctrlKey: true,
      }));
    }

    let yamlContent = String(editor.state.doc.firstChild?.attrs.yamlContent ?? '');
    expect(parseVisibleFrontmatter(yamlContent).userData.tags)
      .toEqual(['alpha', 'beta', 'gammaLongTag']);

    host.querySelector<HTMLElement>(
      '[data-property-key="tags"] .frontmatter-property__display-value',
    )?.click();
    const reopenedPopover = document.body.querySelector<HTMLElement>('.frontmatter-property__edit-popover');
    const reopenedInput = reopenedPopover?.querySelector<HTMLInputElement>('.frontmatter-property__edit-tags-input');
    if (reopenedInput) {
      reopenedInput.value = '';
      reopenedInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      reopenedInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      expect(reopenedPopover?.querySelector<HTMLElement>("[data-keyboard-selected='true']")?.textContent)
        .toContain('beta');
      reopenedInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      reopenedInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
      reopenedInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ctrlKey: true }));
    }
    yamlContent = String(editor.state.doc.firstChild?.attrs.yamlContent ?? '');
    expect(parseVisibleFrontmatter(yamlContent).userData.tags).toEqual(['alpha', 'beta']);

    editor.destroy();
    host.remove();
  });

  it('does not expose removed list or multi-select types for unconfigured fields', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter],
      content: '---\nflowix_key: 8c7dxu0l\nlabels:\n  - alpha\n  - beta\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    host.querySelector<HTMLElement>(
      '[data-property-key="labels"] .frontmatter-property__display-value',
    )?.click();
    const popover = document.body.querySelector<HTMLElement>('.frontmatter-property__edit-popover');
    const typeTrigger = popover?.querySelector<HTMLButtonElement>('.frontmatter-property__edit-type-trigger');
    typeTrigger?.click();
    expect(popover?.querySelector('[data-value="Icon"]')).toBeNull();
    expect(popover?.querySelector('[data-value="Select"]')).toBeNull();
    expect(popover?.querySelector('[data-value="MultiSelect"]')).toBeNull();
    expect(popover?.querySelector('[data-value="Tag"]')).not.toBeNull();

    editor.destroy();
    host.remove();
  });

  it('adds an empty text property in response to the title property action', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter.configure({ propertyTargetId: 'file:display-frontmatter' })],
      content: '---\nflowix_key: 8c7dxu0l\nstatus: todo\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(host.querySelector('.frontmatter-property__tag-add')).toBeNull();
    expect(host.querySelector('.frontmatter-property__tag-input')).toBeNull();
    expect([...host.querySelectorAll('.frontmatter-property__key')]
      .map((element) => element.textContent)).toEqual(['status']);

    window.dispatchEvent(new CustomEvent('flowix:add-property', {
      detail: { propertyTargetId: 'file:display-frontmatter' },
    }));
    expect([...host.querySelectorAll('.frontmatter-property__key')]
      .map((element) => element.textContent)).toEqual(['status', 'key1']);
    expect(host.querySelector('[data-property-key="key1"] .frontmatter-property__value-text')?.textContent)
      .toBe('未设置');
    expect(parseVisibleFrontmatter(
      String(editor.state.doc.firstChild?.attrs.yamlContent ?? ''),
    ).userData.key1).toBe('');

    window.dispatchEvent(new CustomEvent('flowix:add-property', {
      detail: { propertyTargetId: 'file:display-frontmatter' },
    }));
    expect([...host.querySelectorAll('.frontmatter-property__key')]
      .map((element) => element.textContent)).toEqual(['status', 'key1', 'key2']);

    editor.destroy();
    host.remove();
  });

  it('hides the empty property list until a property is added', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter.configure({ propertyTargetId: 'file:display-frontmatter' })],
      content: '---\nflowix_key: 8c7dxu0l\n---\nBody',
      contentType: 'markdown',
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(host.querySelector('.frontmatter-property__list')).toBeNull();
    expect(host.querySelector('.frontmatter-property__add-property')).toBeNull();

    window.dispatchEvent(new CustomEvent('flowix:add-property', {
      detail: { propertyTargetId: 'file:display-frontmatter' },
    }));

    expect(host.querySelector('.frontmatter-property__list')).not.toBeNull();
    expect(host.querySelector('[data-property-key="key1"]')).not.toBeNull();

    editor.destroy();
    host.remove();
  });

  it('creates frontmatter when the title action adds the first property', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter.configure({ propertyTargetId: 'file:empty-document' })],
      content: 'Body without properties',
      contentType: 'markdown',
    });

    window.dispatchEvent(new CustomEvent('flowix:add-property', {
      detail: { propertyTargetId: 'file:empty-document' },
    }));

    expect(editor.state.doc.firstChild?.type.name).toBe('frontmatter');
    expect(editor.state.doc.firstChild?.attrs.yamlContent).toBe('key1: ""');
    expect(parseVisibleFrontmatter(String(editor.state.doc.firstChild?.attrs.yamlContent ?? '')).userData.key1).toBe('');
    expect(host.querySelector('[data-property-key="key1"]')).not.toBeNull();

    editor.destroy();
    host.remove();
  });

  it('reports occupied property keys so callers can disable taken presets', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter.configure({ propertyTargetId: 'file:display-frontmatter' })],
      content: '---\nflowix_key: 8c7dxu0l\nstatus: done\ntags:\n  - a\n---\nBody',
      contentType: 'markdown',
    });

    const keys: string[] = [];
    window.dispatchEvent(new CustomEvent('flowix:query-occupied-property-keys', {
      detail: { propertyTargetId: 'file:display-frontmatter', keys },
    }));

    // User properties are reported. `flowix_key` (the system key) is excluded
    // by `parseVisibleFrontmatter`, matching the preset lists it feeds.
    expect(new Set(keys)).toEqual(new Set(['status', 'tags']));

    // A query aimed at another target must not be answered by this view.
    const otherKeys: string[] = [];
    window.dispatchEvent(new CustomEvent('flowix:query-occupied-property-keys', {
      detail: { propertyTargetId: 'file:someone-else', keys: otherKeys },
    }));
    expect(otherKeys).toEqual([]);

    editor.destroy();
    host.remove();
  });
});

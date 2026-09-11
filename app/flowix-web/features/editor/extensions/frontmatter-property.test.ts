import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import type { I18nKey } from '@/lib/i18n';

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
import { useTagStore } from '@features/memo/store/tag-store';

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

  it('canonicalizes the singular tag key to tags', async () => {
    expect(await generatePropertyKey('tag')).toBe('tags');
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

  it('shows only tag controls while preserving other YAML properties', async () => {
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
    expect([...host.querySelectorAll('.frontmatter-property__tag-label')]
      .map((element) => element.textContent)).toEqual(['#alpha', '#beta']);
    expect([...host.querySelectorAll('.frontmatter-property__tag-chip')]
      .every((element) => element.classList.contains('tag-node'))).toBe(true);
    expect(host.querySelector('.frontmatter-property__tag-add')).not.toBeNull();
    expect(host.querySelector('.frontmatter-property__add-property')).toBeNull();
    expect(host.querySelector('.frontmatter-property__display')).toBeNull();
    expect(host.querySelector('.frontmatter-property__editor')).toBeNull();

    const markdown = editor.getMarkdown();
    expect(markdown).toContain('type: prompt');
    expect(markdown).toContain('status: todo');
    expect(markdown).toContain('keywords: [推广, 归类]');
    expect(markdown).toContain('priority: high');

    editor.destroy();
    host.remove();
  });

  it('renders tags as a standalone wrapping strip and appends from its trailing control', async () => {
    useTagStore.setState({
      tags: [
        { id: 'alpha', name: 'alpha' },
        { id: 'beta', name: 'beta' },
        { id: 'gammaLongTag', name: 'gammaLongTag' },
        { id: 'work/path', name: 'work/path' },
      ],
    });
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
      .map((element) => element.textContent)).toEqual([]);
    expect(host.querySelector('.frontmatter-property__add-property')).toBeNull();
    expect([...host.querySelectorAll('.frontmatter-property__tag-label')]
      .map((element) => element.textContent)).toEqual(['#alpha', '#beta']);
    const addButton = host.querySelector<HTMLButtonElement>('.frontmatter-property__tag-add');
    expect(addButton).not.toBeNull();
    expect(addButton?.textContent).toBe('添加标签');
    if (addButton) {
      addButton.getBoundingClientRect = () => ({
        x: 0,
        y: 0,
        width: 88,
        height: 24,
        top: 0,
        right: 88,
        bottom: 24,
        left: 0,
        toJSON: () => ({}),
      });
    }
    addButton?.click();
    await Promise.resolve();

    const input = host.querySelector<HTMLInputElement>('.frontmatter-property__tag-input');
    expect(input).not.toBeNull();
    if (input) {
      expect(input.hasAttribute('placeholder')).toBe(false);
      expect(input.getAttribute('aria-label')).toBe('输入标签后回车');
      expect(input.style.width).toBe('88px');
      const tagMenu = document.body.querySelector<HTMLElement>(
        '.frontmatter-property__tag-suggestions',
      );
      expect(tagMenu?.hidden).toBe(false);
      expect(tagMenu?.parentElement).toBe(document.body);
      expect(tagMenu?.style.position).toBe('fixed');
      expect([...document.body.querySelectorAll('.mention-tag-name')]
        .map((element) => element.textContent)).toEqual(['gammaLongTag', 'work/path']);
      const hierarchicalTag = [...document.body.querySelectorAll<HTMLElement>('.mention-tag-name')]
        .find((element) => element.textContent === 'work/path');
      expect([...hierarchicalTag?.querySelectorAll('.mention-tag-segment') ?? []]
        .map((element) => element.textContent)).toEqual(['work', 'path']);
      expect(hierarchicalTag?.querySelector('.mention-tag-name-content')?.textContent)
        .toBe('work/path');
      expect(hierarchicalTag?.querySelector('.mention-tag-separator')?.textContent).toBe('/');
      expect(document.body.querySelector('.frontmatter-property__tag-suggestions .mention-tag-icon')
        ?.textContent).toBe('');
      expect(document.body.querySelector(
        '.frontmatter-property__tag-suggestions .overlay-scrollbar-frame',
      )).not.toBeNull();
      expect(document.body.querySelector(
        '.frontmatter-property__tag-suggestions .overlay-scrollbar-thumb',
      )).not.toBeNull();
      const suggestionItems = document.body.querySelector<HTMLElement>(
        '.frontmatter-property__tag-suggestion-items',
      );
      const initialOptions = document.body.querySelectorAll<HTMLButtonElement>(
        '.mention-note-item',
      );
      if (suggestionItems && initialOptions[1]) {
        Object.defineProperties(suggestionItems, {
          clientHeight: { configurable: true, value: 40 },
          scrollHeight: { configurable: true, value: 100 },
        });
        suggestionItems.getBoundingClientRect = () => ({
          x: 0,
          y: 0,
          width: 172,
          height: 40,
          top: 0,
          right: 172,
          bottom: 40,
          left: 0,
          toJSON: () => ({}),
        });
        initialOptions[1].getBoundingClientRect = () => ({
          x: 0,
          y: 50,
          width: 172,
          height: 20,
          top: 50,
          right: 172,
          bottom: 70,
          left: 0,
          toJSON: () => ({}),
        });
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
        }));
        expect(suggestionItems.scrollTop).toBe(30);
      }
      Object.defineProperty(input, 'scrollWidth', {
        configurable: true,
        value: 140,
      });
      input.value = 'gamma';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(input.style.width).toBe('141px');
      expect([...document.body.querySelectorAll('.mention-tag-name')]
        .map((element) => element.textContent)).toEqual(['gamma', 'gammaLongTag']);
      document.body.querySelectorAll<HTMLButtonElement>('.mention-note-item')[1]?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true }),
      );
    }

    expect([...host.querySelectorAll('.frontmatter-property__tag-label')]
      .map((element) => element.textContent)).toEqual(['#alpha', '#beta', '#gammaLongTag']);
    expect(editor.getMarkdown()).toContain('tags:');
    expect(editor.getMarkdown()).toContain('- gammaLongTag');
    expect(editor.getMarkdown()).toContain('status: todo');

    useTagStore.setState({ tags: [] });
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
      .map((element) => element.textContent)).toEqual(['#newtag']);

    editor.destroy();
    host.remove();
  });
});

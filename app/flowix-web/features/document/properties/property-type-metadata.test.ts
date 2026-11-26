import { act } from 'react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import Frontmatter from '@features/editor/extensions/frontmatter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '@/lib/store/settings-store';
import { parseDocument } from 'yaml';
import { resolvePropertyType } from './property-type';
import { deleteVisibleFrontmatterProperty, parseVisibleFrontmatter, replaceVisibleFrontmatterProperties, updateVisibleFrontmatterProperty } from './frontmatter-model';
import { patchDocumentProperties } from '../public/path-properties';
import { usePropertyPresetStore } from '@features/properties/property-preset-store';

const initialSettings = usePropertyPresetStore.getState().registry;
let previousPropertiesVisible: boolean;
beforeEach(() => {
  previousPropertiesVisible = useSettingsStore.getState().propertiesVisible;
  useSettingsStore.setState({ propertiesVisible: true });
});
afterEach(() => {
  usePropertyPresetStore.setState({ registry: initialSettings });
  useSettingsStore.setState({ propertiesVisible: previousPropertiesVisible });
});
const data = (yaml: string) => parseDocument(yaml).toJS();

describe('persisted property types', () => {
  it('reopens a table Tag as Tag and hides its metadata in the note editor', async () => {
    const content = patchDocumentProperties('Body', { subjects: ['work'] }, [], { subjects: 'Tag' });
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({ element: host, extensions: [StarterKit, Markdown, Frontmatter], content, contentType: 'markdown' });
    try {
      expect(host.querySelector('[data-property-key="flowix_property_types"]')).toBeNull();
      await act(async () => host.querySelector<HTMLElement>('[data-property-key="subjects"] .frontmatter-property__display-value')?.click());
      expect(document.body.querySelector('.frontmatter-property__edit-type-label')?.textContent).toBe('标签');
      expect(document.body.querySelector('.frontmatter-property__edit-tag-chip--plain')).not.toBeNull();
    } finally {
      await act(async () => editor.destroy());
      host.remove();
    }
  });

  it('distinguishes Tag and MultiSelect after saving and reopening', () => {
    const yaml = updateVisibleFrontmatterProperty('', null, 'topics', '#work, 带 空格', 'Tag');
    const parsed = parseVisibleFrontmatter(yaml);
    expect(parsed.data.flowix_property_types).toEqual({ topics: 'Tag' });
    expect(parsed.properties.map((row) => row.key)).toEqual(['topics']);
    expect(parsed.userData).not.toHaveProperty('flowix_property_types');
    expect(resolvePropertyType('topics', parsed.userData.topics, false, [], parsed.data.flowix_property_types).kind).toBe('Tag');
    expect(resolvePropertyType('legacy', ['work']).kind).toBe('MultiSelect');
  });

  it('uses presets ahead of declarations and only writes non-preset types', () => {
    usePropertyPresetStore.setState({ registry: { ...initialSettings, fields: [{ key: 'topics', type: 'Tag' }] } });
    const yaml = updateVisibleFrontmatterProperty('topics: [work]\nflowix_property_types:\n  topics: MultiSelect', 'topics', 'topics', 'work, life', 'Tag');
    expect(data(yaml)).not.toHaveProperty('flowix_property_types');
    const tableWrite = patchDocumentProperties('---\ntopics: [work]\n---\nBody', { topics: ['life'] }, [], { topics: 'Tag' });
    expect(parseVisibleFrontmatter(tableWrite.split('---')[1]).data).not.toHaveProperty('flowix_property_types');
    const renamed = updateVisibleFrontmatterProperty(yaml, 'topics', 'subjects', 'work, life');
    expect(data(renamed).flowix_property_types).toEqual({ subjects: 'Tag' });
    expect(resolvePropertyType('topics', [], false, [{ key: 'topics', type: 'Tag' }], { topics: 'MultiSelect' }).kind).toBe('Tag');
    expect(data(updateVisibleFrontmatterProperty('', null, 'tags', '#work', 'Tag'))).not.toHaveProperty('flowix_property_types');
    expect(resolvePropertyType('tags', [], false, [], { tags: 'Text' }).kind).toBe('Tag');
  });

  it('can retain a type declaration after its shared preset is deleted', () => {
    usePropertyPresetStore.setState({ registry: { ...initialSettings, fields: [{ key: 'topics', type: 'Tag' }] } });
    const content = patchDocumentProperties('---\ntopics: [work]\n---\nBody', { topics: ['work'] }, [], { topics: 'Tag' }, ['topics']);
    expect(data(content).flowix_property_types).toEqual({ topics: 'Tag' });
  });

  it('moves and removes declarations with their property', () => {
    const original = 'topics: [work]\nflowix_property_types:\n  topics: Tag\n  other: Number\nother: 1';
    const renamed = updateVisibleFrontmatterProperty(original, 'topics', 'subjects', 'work');
    expect(data(renamed).flowix_property_types).toEqual({ subjects: 'Tag', other: 'Number' });
    const removed = deleteVisibleFrontmatterProperty(renamed, 'subjects');
    expect(data(removed).flowix_property_types).toEqual({ other: 'Number' });
    expect(data(deleteVisibleFrontmatterProperty(removed, 'other'))).not.toHaveProperty('flowix_property_types');
  });

  it('protects the metadata key and ignores invalid type declarations', () => {
    expect(() => updateVisibleFrontmatterProperty('', null, 'flowix_property_types', 'oops', 'Text')).toThrow();
    expect(resolvePropertyType('topics', [], false, [], { topics: 'unknown' }).kind).toBe('MultiSelect');
    expect(resolvePropertyType('topics', [], false, [], { topics: 'noteTag' }).kind).toBe('Tag');
  });

  it('retains unrelated declarations and body bytes in table writes', () => {
    const source = '---\n# keep\nother: 1\nflowix_property_types:\n  other: Number\n---\n# Body\r\n';
    const content = patchDocumentProperties(source, { topics: ['work'] }, [], { topics: 'Tag' });
    expect(content).toContain('# keep');
    expect(content.endsWith('# Body\r\n')).toBe(true);
    expect(parseVisibleFrontmatter(content.split('---')[1]).data.flowix_property_types).toEqual({ other: 'Number', topics: 'Tag' });
    const renamed = patchDocumentProperties(content, { subjects: ['work'] }, ['topics']);
    expect(parseVisibleFrontmatter(renamed.split('---')[1]).data.flowix_property_types).toEqual({ other: 'Number', subjects: 'Tag' });
  });

  it('backfills even when the editor saves an unchanged legacy value', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({ element: host, extensions: [StarterKit, Markdown, Frontmatter], content: '---\nsubjects: [work]\ncount: 2\n---\nBody', contentType: 'markdown' });
    try {
      await act(async () => host.querySelector<HTMLElement>('[data-property-key="subjects"] .frontmatter-property__display-value')?.click());
      await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
      const yaml = String(editor.state.doc.firstChild?.attrs.yamlContent);
      expect(data(yaml).flowix_property_types).toEqual({ subjects: 'MultiSelect', count: 'Number' });
      expect(host.querySelector('[data-property-key="flowix_property_types"]')).toBeNull();
    } finally {
      await act(async () => editor.destroy());
      host.remove();
    }
  });

  it('infers from the old value when the first legacy edit clears its value', () => {
    const saved = updateVisibleFrontmatterProperty('count: 2', 'count', 'count', '');
    expect(data(saved).flowix_property_types.count).toBe('Number');
    const content = patchDocumentProperties('---\ncount: 2\n---\nBody', { count: '' });
    expect(parseVisibleFrontmatter(content.split('---')[1]).data.flowix_property_types).toEqual({ count: 'Number' });
  });

  it('backfills inferable non-preset properties once at the next attribute save', () => {
    const original = 'topics: [work]\ncount: 2\nenabled: true\nwhen: 2026-10-14\nlink: https://example.com\nlabel: hello\ntags: [work]';
    const saved = updateVisibleFrontmatterProperty(original, 'label', 'label', 'updated', 'Text');
    // Text is the fallback and Date is inferred from the value, so neither is persisted.
    expect(data(saved).flowix_property_types).toEqual({ topics: 'MultiSelect', count: 'Number', enabled: 'Boolean', link: 'URL' });
    expect(resolvePropertyType('when', '2026-10-14', false, [], data(saved).flowix_property_types).kind).toBe('Date');
    expect(resolvePropertyType('label', 'updated', false, [], data(saved).flowix_property_types).kind).toBe('Text');
  });

  it('infers a deleted user preset and persists the fallback on the next save', () => {
    const fields = [{ key: 'subjects', type: 'Tag' as const }];
    usePropertyPresetStore.setState({ registry: { ...initialSettings, fields } });
    const withPreset = updateVisibleFrontmatterProperty('subjects: [work]', 'subjects', 'subjects', 'work', 'Tag');
    expect(data(withPreset)).not.toHaveProperty('flowix_property_types');
    usePropertyPresetStore.setState({ registry: { ...initialSettings, fields: [] } });
    const saved = updateVisibleFrontmatterProperty(withPreset, 'subjects', 'subjects', 'work');
    expect(data(saved).flowix_property_types.subjects).toBe('MultiSelect');
    const next = updateVisibleFrontmatterProperty(saved, 'subjects', 'subjects', '');
    expect(data(next).flowix_property_types.subjects).toBe('MultiSelect');
  });

  it('backfills path writes but preserves existing declarations and removes stale entries', () => {
    const source = '---\nsubjects: [work]\nlabel: original\nflowix_property_types:\n  subjects: noteTag\n  missing: Number\n  label: Invalid\n---\nBody';
    const saved = patchDocumentProperties(source, { label: 'updated' });
    expect(parseVisibleFrontmatter(saved.split('---')[1]).data.flowix_property_types).toEqual({ subjects: 'Tag' });
    const replaced = replaceVisibleFrontmatterProperties('---\nsubjects: [work]\n---\nBody', [{ key: 'subjects', value: ['life'] }]);
    expect(parseVisibleFrontmatter(replaced.split('---')[1]).data.flowix_property_types).toEqual({ subjects: 'MultiSelect' });
  });

  it('cleans removed types during whole-property replacement', () => {
    const content = replaceVisibleFrontmatterProperties('---\nold: [work]\nflowix_property_types:\n  old: Tag\n---\nBody', [{ key: 'new', value: ['life'], kind: 'MultiSelect' }]);
    expect(parseVisibleFrontmatter(content.split('---')[1]).data.flowix_property_types).toEqual({ new: 'MultiSelect' });
  });
});

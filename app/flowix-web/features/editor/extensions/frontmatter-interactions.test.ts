import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import Frontmatter from './frontmatter';
import { useSettingsStore } from '@/lib/store/settings-store';

let previousPropertiesVisible: boolean;
beforeEach(() => {
  previousPropertiesVisible = useSettingsStore.getState().propertiesVisible;
  useSettingsStore.setState({ propertiesVisible: true });
});
afterEach(() => useSettingsStore.setState({ propertiesVisible: previousPropertiesVisible }));

function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new Editor({
    element: host,
    extensions: [StarterKit, Markdown, Frontmatter],
    content: '---\nenabled: false\nfirst: old\nsecond: next\n---\nBody',
    contentType: 'markdown',
  });
  const setEditable = (editable: boolean) => {
    editor.view.dom.dispatchEvent(new Event('flowix:editor-flush-drafts'));
    editor.setEditable(editable, false);
    editor.view.dom.dispatchEvent(new Event('flowix:editor-editability-change'));
  };
  const value = (key: string) => host.querySelector<HTMLElement>(`[data-property-key="${key}"] .frontmatter-property__display-value`)!;
  const draft = () => document.body.querySelector<HTMLTextAreaElement>('.frontmatter-property__edit-input')!;
  return { host, editor, setEditable, value, draft, dispose: () => { editor.destroy(); host.remove(); } };
}

describe('frontmatter workspace interactions', () => {
  it('updates the same checkbox across read-only transitions and guards stale change events', () => {
    const f = fixture();
    try {
      const checkbox = f.host.querySelector<HTMLInputElement>('.frontmatter-property__value-checkbox')!;
      f.setEditable(false);
      expect(checkbox.disabled).toBe(true);
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      expect(f.editor.getMarkdown()).toContain('enabled: false');
      f.setEditable(true);
      expect(f.host.querySelector('.frontmatter-property__value-checkbox')).toBe(checkbox);
      expect(checkbox.disabled).toBe(false);
      checkbox.checked = false;
      checkbox.click();
      expect(f.editor.getMarkdown()).toContain('enabled: true');
    } finally { f.dispose(); }
  });

  it('keeps the saved property icon menu actions working', () => {
    const f = fixture();
    try {
      const icon = f.host.querySelector<HTMLElement>('[data-property-key="first"] .frontmatter-property__type-icon')!;
      icon.click();
      const actions = document.body.querySelectorAll<HTMLButtonElement>('.frontmatter-property__item-menu [role="menuitem"]');
      expect(actions).toHaveLength(3);
      expect(actions[0].disabled).toBe(false);
      expect(actions[1].disabled).toBe(false);
      actions[2].click();
      expect(f.host.querySelector('[data-property-key="first"]')).toBeNull();
      expect(f.editor.getMarkdown()).not.toContain('first:');
    } finally { f.dispose(); }
  });

  it('commits a draft before the editor becomes read-only', () => {
    const f = fixture();
    try {
      f.value('first').click();
      f.draft().value = 'saved';
      f.setEditable(false);
      expect(f.editor.getMarkdown()).toContain('first: saved');
      expect(document.body.querySelector('.frontmatter-property__edit-popover')).toBeNull();
    } finally { f.dispose(); }
  });

  it('preserves the next pointer target while saving another property', () => {
    const f = fixture();
    try {
      f.value('first').click();
      f.draft().value = 'saved';
      const next = f.value('second');
      const list = next.closest('.frontmatter-property__list');
      next.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(f.editor.getMarkdown()).toContain('first: saved');
      expect(f.value('second')).toBe(next);
      expect(next.isConnected).toBe(true);
      expect(next.closest('.frontmatter-property__list')).toBe(list);
      next.click();
      expect(f.draft().value).toBe('next');
    } finally { f.dispose(); }
  });
});

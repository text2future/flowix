import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it, vi } from 'vitest';
import { ImeEnterGuard } from './ime-enter-guard';

describe('IME Enter guard', () => {
  it('preserves candidate confirmation while allowing a subsequent normal Enter', () => {
    const element = document.createElement('div');
    document.body.append(element);
    const editor = new Editor({ element, extensions: [StarterKit, ImeEnterGuard], content: '<p>中文</p>' });
    const dom = editor.view.dom;
    editor.commands.focus('end');
    dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    dom.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(editor.getHTML()).toBe('<p>中文</p>');
    dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    const webkitEnter = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true });
    dom.dispatchEvent(webkitEnter);
    expect(webkitEnter.defaultPrevented).toBe(false);
    expect(editor.getHTML()).toBe('<p>中文</p>');
    dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(editor.getHTML()).toBe('<p>中文</p><p></p>');
    editor.destroy();
    element.remove();
  });

  it('blocks a same-turn Enter after compositionend, but permits later Enter', () => {
    vi.useFakeTimers();
    const element = document.createElement('div');
    document.body.append(element);
    const editor = new Editor({ element, extensions: [StarterKit, ImeEnterGuard], content: '<p>中文</p>' });
    const dom = editor.view.dom;
    editor.commands.focus('end');
    dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    const enter = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true });
    dom.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(editor.getHTML()).toBe('<p>中文</p>');
    dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    vi.advanceTimersByTime(0);
    dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    expect(editor.getHTML()).toBe('<p>中文</p><p></p>');
    editor.destroy();
    element.remove();
    vi.useRealTimers();
  });
});

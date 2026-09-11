import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findHeadingByAnchor,
  navigateToHeadingAnchor,
} from './heading-anchor-navigation';

function rect(top: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 0,
    bottom: top,
    left: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  };
}

describe('heading anchor navigation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
  });

  it('matches Chinese, punctuation, encoded, and duplicate GitHub slugs', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <h2>基础 Slide 外壳</h2>
      <h2>Chrome &amp; Foot</h2>
      <h2>重复标题</h2>
      <h2>重复标题</h2>
    `;

    expect(findHeadingByAnchor(root, '#基础-slide-外壳')?.textContent).toBe('基础 Slide 外壳');
    expect(findHeadingByAnchor(root, '#chrome--foot')?.textContent).toBe('Chrome & Foot');
    expect(findHeadingByAnchor(root, '#%E9%87%8D%E5%A4%8D%E6%A0%87%E9%A2%98-1'))
      .toBe(root.querySelectorAll('h2')[3]);
  });

  it('ignores headings rendered inside embedded editor nodes', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="agent-thread-card"><h2>目标</h2></div>
      <h2>目标</h2>
    `;

    expect(findHeadingByAnchor(root, '#目标')).toBe(root.lastElementChild);
  });

  it('scrolls only the current editor container with a top offset', () => {
    const scrollContainer = document.createElement('div');
    scrollContainer.className = 'editor-content';
    scrollContainer.scrollTop = 100;
    const editorRoot = document.createElement('div');
    const target = document.createElement('h2');
    target.textContent = '基础 Slide 外壳';
    editorRoot.append(target);
    scrollContainer.append(editorRoot);
    document.body.append(scrollContainer);

    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue(rect(50));
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rect(250));
    const scrollTo = vi.fn();
    scrollContainer.scrollTo = scrollTo;

    expect(navigateToHeadingAnchor(editorRoot, '#基础-slide-外壳')).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 284, behavior: 'smooth' });
  });

  it('does not scroll when the fragment has no matching heading', () => {
    const root = document.createElement('div');
    root.innerHTML = '<h2>Existing</h2>';

    expect(navigateToHeadingAnchor(root, '#missing')).toBe(false);
  });
});

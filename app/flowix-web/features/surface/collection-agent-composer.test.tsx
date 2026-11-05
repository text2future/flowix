vi.mock('@features/workspace/public/session-api', () => ({ columnAtIndex: (index: number) => index === 0 ? 'column-1' : 'column-2' }));
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  createWithPrompt: vi.fn(),
}));

vi.mock('@features/agent/public/shell-api', () => ({
  createAndOpenAgentConversationWithPrompt: calls.createWithPrompt,
  useNewConversationAgentSelection: () => ({
    kind: 'create',
    agentType: 'pi',
    options: [{ id: 'pi', name: 'Pi' }],
  }),
}));
vi.mock('@features/agent/public/icon-api', () => ({
  AgentIcon: () => null,
}));
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import { CollectionAgentComposer } from './collection-agent-composer';

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  vi.clearAllMocks();
});

async function renderComposer(
  notebookId: string | null = 'nb-1',
  host: 'column-1' | 'column-2' = 'column-1',
): Promise<HTMLInputElement> {
  const node = document.createElement('div');
  root = createRoot(node);
  await act(async () => root?.render(<CollectionAgentComposer
    notebookId={notebookId}
    collectionId="col-1"
    collectionName="Flowix"
    collectionPath="/tmp/Flowix"
    indexPath="/tmp/Flowix/.index.yaml"
    host={host}
  />));
  const input = node.querySelector('input');
  if (!input) throw new Error('composer input missing');
  return input;
}

/** 胶囊本体就是输入框的直接父节点，宽度动画写在它的 inline style 上。 */
function pillOf(input: HTMLInputElement): HTMLElement {
  const pill = input.parentElement;
  if (!pill) throw new Error('composer pill missing');
  return pill;
}

async function focus(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
}

async function blur(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  });
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressEnter(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

describe('CollectionAgentComposer', () => {
  it('收起态固定 120px，聚焦后伸展到上限 680px，失焦收回', async () => {
    const input = await renderComposer();
    const pill = pillOf(input);

    expect(pill.style.width).toBe('120px');

    await focus(input);
    // jsdom 无布局：容器宽度量不到时按「不超过 680px」的上限展开。
    expect(pill.style.width).toBe('680px');

    await blur(input);
    expect(pill.style.width).toBe('120px');
  });

  it('有草稿时不因失焦收回，避免裁掉已输入内容', async () => {
    const input = await renderComposer();
    const pill = pillOf(input);

    await focus(input);
    await type(input, '帮我总结这个集合');
    await blur(input);

    expect(pill.style.width).toBe('680px');
  });

  it('发送时在 browser 列新开会话并自动发送输入内容', async () => {
    const input = await renderComposer('nb-1', 'column-1');
    await type(input, '  帮我总结这个集合  ');
    await pressEnter(input);

    expect(calls.createWithPrompt).toHaveBeenCalledWith('pi', 'nb-1', expect.stringContaining('帮我总结这个集合'), {
      destination: 1,
      autoSend: true,
    });
    const sentPrompt = calls.createWithPrompt.mock.calls[0]?.[2] as string;
    expect(sentPrompt.startsWith('帮我总结这个集合\n\n参考集合资料 [@Flowix](flowix://collection/')).toBe(true);
    expect(sentPrompt).toContain(encodeURIComponent('"collectionId":"col-1"'));
    expect(sentPrompt.endsWith(')')).toBe(true);
    expect(input.value).toBe('');
    expect(pillOf(input).style.width).toBe('120px');
  });

  it('集合自己就在 browser 列时，会话开到 Work，避免顶掉集合', async () => {
    const input = await renderComposer('nb-1', 'column-2');
    await type(input, 'hi');
    await pressEnter(input);

    expect(calls.createWithPrompt).toHaveBeenCalledWith('pi', 'nb-1', expect.stringContaining('hi'), {
      destination: 0,
      autoSend: true,
    });
  });

  it('没有笔记本上下文时不发送', async () => {
    const input = await renderComposer(null);
    await type(input, 'hi');
    await pressEnter(input);

    expect(calls.createWithPrompt).not.toHaveBeenCalled();
  });
});

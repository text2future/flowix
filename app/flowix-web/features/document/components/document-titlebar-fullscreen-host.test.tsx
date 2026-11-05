import { reportWorkspaceHeaderFullscreen, clearWorkspaceHeaderFullscreen } from '@features/workspace/public/header-api';
import { normalizeAgentTypeKey } from '@/lib/agent-types';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentThreadCardFullscreenExitButton,
  useAgentThreadCardFullscreenActive,
  useFullscreenAgentThreadCardInfo,
} from '@features/document/components/document-titlebar-shared';

const fullscreenOwners = new Map<'column-1' | 'column-2', object>();

// 仓库测试惯例 (无 @testing-library): createRoot 挂 probe 组件, hook 状态
// 写到外层变量。这里同时探针两个 host 的 active / info, 断言互不串扰。
interface HostScopeProbeState {
  mainThirdActive: boolean;
  browserColumnActive: boolean;
  mainThirdInfo: ReturnType<typeof useFullscreenAgentThreadCardInfo>;
  browserColumnInfo: ReturnType<typeof useFullscreenAgentThreadCardInfo>;
}

let probeState: HostScopeProbeState | null = null;

function HostScopeProbe() {
  probeState = {
    mainThirdActive: useAgentThreadCardFullscreenActive('column-1'),
    browserColumnActive: useAgentThreadCardFullscreenActive('column-2'),
    mainThirdInfo: useFullscreenAgentThreadCardInfo('column-1'),
    browserColumnInfo: useFullscreenAgentThreadCardInfo('column-2'),
  };
  return null;
}

function buildWorkspaceHosts(): {
  mainThird: HTMLElement;
  browserColumn: HTMLElement;
} {
  const mainThird = document.createElement('div');
  mainThird.dataset.workspaceHost = 'column-1';
  const browserColumn = document.createElement('div');
  browserColumn.dataset.workspaceHost = 'column-2';
  document.body.append(mainThird, browserColumn);
  return { mainThird, browserColumn };
}

// Publish the same owner-bound snapshot as the real AgentThreadCardView.
function mountFullscreenCard(
  host: HTMLElement,
  attrs: Partial<Record<'title' | 'agentType' | 'instanceId' | 'threadId', string>>,
): HTMLElement {
  const container = document.createElement('div');
  container.className = 'document-container';
  const card = document.createElement('div');
  card.className = 'agent-thread-card agent-thread-card--fullscreen';
  for (const [key, value] of Object.entries(attrs)) {
    card.dataset[key] = value;
  }
  container.appendChild(card);
  host.appendChild(container);
  const hostId = host.dataset.workspaceHost as 'column-1' | 'column-2';
  fullscreenOwners.set(hostId, card);
  act(() => reportWorkspaceHeaderFullscreen(hostId, card, {
    title: attrs.title ?? '', typeKey: normalizeAgentTypeKey(attrs.agentType),
    instanceId: attrs.instanceId ?? null, threadId: attrs.threadId ?? null,
  }));
  return card;
}

describe('AgentThreadCard fullscreen host scoping', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let mainThird: HTMLElement | null = null;
  let browserColumn: HTMLElement | null = null;

  beforeEach(() => {
    probeState = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    ({ mainThird, browserColumn } = buildWorkspaceHosts());
  });

  afterEach(() => {
    act(() => {
      for (const [host, owner] of fullscreenOwners) clearWorkspaceHeaderFullscreen(host, owner);
    });
    fullscreenOwners.clear();
    act(() => root?.unmount());
    mainThird?.remove();
    browserColumn?.remove();
    container?.remove();
    root = null;
    container = null;
    mainThird = null;
    browserColumn = null;
    probeState = null;
  });

  function mountProbe(): void {
    act(() => {
      root?.render(createElement(HostScopeProbe));
    });
  }

  it('浏览器列卡片全屏: 浏览器列 hook 拿到信息, 第三列不激活', () => {
    mountFullscreenCard(browserColumn!, {
      title: '浏览器列对话',
      agentType: 'claude',
      instanceId: 'inst-4',
      threadId: 'thread-4',
    });
    mountProbe();

    expect(probeState?.browserColumnActive).toBe(true);
    expect(probeState?.mainThirdActive).toBe(false);
    expect(probeState?.mainThirdInfo).toBeNull();
    expect(probeState?.browserColumnInfo).toEqual({
      title: '浏览器列对话',
      typeKey: 'claudecode',
      instanceId: 'inst-4',
      threadId: 'thread-4',
    });
  });

  it('第三列卡片全屏: 第三列 hook 拿到信息, 浏览器列不激活', () => {
    mountFullscreenCard(mainThird!, {
      title: '第三列对话',
      agentType: 'codex',
      instanceId: 'inst-3',
      threadId: 'thread-3',
    });
    mountProbe();

    expect(probeState?.mainThirdActive).toBe(true);
    expect(probeState?.browserColumnActive).toBe(false);
    expect(probeState?.browserColumnInfo).toBeNull();
    expect(probeState?.mainThirdInfo).toEqual({
      title: '第三列对话',
      typeKey: 'codex',
      instanceId: 'inst-3',
      threadId: 'thread-3',
    });
  });

  it('owner snapshots update hooks and clear when the card exits', () => {
    mountProbe();
    expect(probeState?.mainThirdActive).toBe(false);
    expect(probeState?.browserColumnActive).toBe(false);

    const card = mountFullscreenCard(browserColumn!, { title: '后来全屏' });
    expect(probeState?.browserColumnActive).toBe(true);
    expect(probeState?.browserColumnInfo?.title).toBe('后来全屏');

    card.remove();
    act(() => clearWorkspaceHeaderFullscreen('column-2', card));
    expect(probeState?.browserColumnActive).toBe(false);
    expect(probeState?.browserColumnInfo).toBeNull();
  });

  it('退出按钮只对所属 host 的全屏卡片渲染', () => {
    function renderExitButton(host: 'column-1' | 'column-2'): void {
      act(() => {
        root?.render(createElement(AgentThreadCardFullscreenExitButton, {
          host,
          className: 'agent-thread-card-fullscreen-exit-btn',
        }));
      });
    }

    // 第三列卡片全屏: 浏览器列退出按钮不渲染
    mountFullscreenCard(mainThird!, { title: '第三列对话' });
    renderExitButton('column-2');
    expect(container?.querySelector('button.agent-thread-card-fullscreen-exit-btn')).toBeNull();

    // 换成浏览器列卡片全屏: 浏览器列退出按钮出现
    mountFullscreenCard(browserColumn!, { title: '浏览器列对话' });
    renderExitButton('column-2');
    const button = container?.querySelector('button.agent-thread-card-fullscreen-exit-btn');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-label')).toBeTruthy();

    let requestHost: string | undefined;
    const handleRequest = (event: Event) => {
      requestHost = (event as CustomEvent<{ host?: string }>).detail?.host;
    };
    window.addEventListener('flowix:agent-thread-card-request-fullscreen', handleRequest);
    act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    window.removeEventListener('flowix:agent-thread-card-request-fullscreen', handleRequest);
    expect(requestHost).toBe('column-2');
  });
});

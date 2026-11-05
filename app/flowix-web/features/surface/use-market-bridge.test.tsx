import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  readNotebookAgentSkills: vi.fn().mockResolvedValue([{ id: 'writing' }]),
  listInstalledNotebookTemplates: vi.fn().mockResolvedValue(['work-plan']),
  installCodexProjectSkillZip: vi.fn().mockResolvedValue({}), installNotebookTemplateZip: vi.fn(),
  notify: vi.fn(), show: vi.fn(),
}));
vi.mock('@platform/tauri/client', () => ({ agent: mocks }));
vi.mock('@features/memo/public/selected-notebook-api', () => ({
  getSelectedNotebookSnapshot: () => ({ id: 'A', name: 'A', path: '/A' }),
  subscribeSelectedNotebook: () => () => {},
}));
vi.mock('@features/agent/public/notebook-skills-api', () => ({ NOTEBOOK_SKILLS_CHANGED_EVENT: 'skills-changed', notifyNotebookSkillsChanged: mocks.notify }));
vi.mock('@/lib/toast', () => ({ toast: { show: mocks.show } }));
import { useMarketBridge } from './use-market-bridge';
const origin = 'https://skills.flowix.cc';
async function mountBridge(frame: HTMLIFrameElement) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const options = { iframeRef: { current: frame }, origin, currentUrl: `${origin}/i/index`, reloadToken: 0, language: 'zh-CN', onReady: vi.fn() };
  function Bridge() { useMarketBridge(options); return null; }
  await act(async () => { root.render(createElement(Bridge)); });
  return async () => { await act(async () => root.unmount()); };
}
afterEach(() => { document.body.innerHTML = ''; vi.clearAllMocks(); });
describe('market bridge', () => {
  it('advertises toast support and discovers templates without a fixed catalog', async () => {
    const frame = document.createElement('iframe'); document.body.append(frame);
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    const unmount = await mountBridge(frame);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ capabilities: { toast: true }, installedTemplateIds: ['work-plan'], installedSkillIds: ['writing'] }), origin);
    await unmount();
  });
  it('accepts installation messages only from its own frame and configured origin', async () => {
    const frame = document.createElement('iframe'); document.body.append(frame);
    const unmount = await mountBridge(frame);
    const data = { type: 'flowix:skill-market:install', requestId: 'r', notebookId: 'A', skill: { id: 'example', displayName: 'Example', archive: { url: `${origin}/skills/archives/example.zip` } } };
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.example', source: frame.contentWindow, data }));
      window.dispatchEvent(new MessageEvent('message', { origin, source: window, data }));
    });
    expect(mocks.installCodexProjectSkillZip).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new MessageEvent('message', { origin, source: frame.contentWindow, data })); });
    expect(mocks.installCodexProjectSkillZip).toHaveBeenCalledOnce();
    await unmount();
  });
});

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  readNotebookAgentSkills: vi.fn().mockResolvedValue([{ id: 'writing' }]),
  listInstalledNotebookTemplates: vi.fn().mockResolvedValue(['work-plan']),
  installCodexProjectSkillZip: vi.fn().mockResolvedValue({}), installNotebookTemplateZip: vi.fn(),
  notify: vi.fn(), show: vi.fn(),
}));
vi.mock('@platform/tauri/client', () => ({ agent: mocks, product: { getInfo: async () => ({ version: '1.5.17' }) } }));
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
  return Object.assign(async () => { await act(async () => root.unmount()); }, {
    update: async (patch: Partial<typeof options>) => {
      Object.assign(options, patch);
      await act(async () => { root.render(createElement(Bridge)); });
    },
  });
}
afterEach(() => { document.body.innerHTML = ''; vi.clearAllMocks(); });
describe('market bridge', () => {
  it('advertises toast support and discovers templates without a fixed catalog', async () => {
    const frame = document.createElement('iframe'); document.body.append(frame);
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    const unmount = await mountBridge(frame);
    expect(post.mock.calls.every(([data]) => data.type === 'flowix:skill-market:probe')).toBe(true);
    await act(async () => {
      frame.dispatchEvent(new Event('load'));
      window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.example', source: frame.contentWindow, data: { type: 'flowix:skill-market:ready' } }));
      window.dispatchEvent(new MessageEvent('message', { origin, source: window, data: { type: 'flowix:skill-market:ready' } }));
    });
    expect(post.mock.calls.every(([data]) => data.type === 'flowix:skill-market:probe')).toBe(true);
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { origin, source: frame.contentWindow, data: { type: 'flowix:skill-market:ready' } }));
    });
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
    await act(async () => { window.dispatchEvent(new MessageEvent('message', { origin, source: frame.contentWindow, data: { type: 'flowix:skill-market:ready' } })); });
    await act(async () => { window.dispatchEvent(new MessageEvent('message', { origin, source: frame.contentWindow, data })); });
    expect(mocks.installCodexProjectSkillZip).toHaveBeenCalledOnce();
    await unmount();
  });
});

it('preserves readiness across presentation updates and resets it on reload', async () => {
  const frame = document.createElement('iframe'); document.body.append(frame);
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  const unmount = await mountBridge(frame);
  const ready = () => window.dispatchEvent(new MessageEvent('message', { origin, source: frame.contentWindow, data: { type: 'flowix:skill-market:ready' } }));
  await act(async () => { ready(); });
  post.mockClear();
  await unmount.update({ language: 'en-US', onReady: vi.fn() });
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'flowix:skill-market:context', language: 'en-US' }), origin);
  post.mockClear();
  await act(async () => { window.dispatchEvent(new Event('skills-changed')); });
  expect(post).toHaveBeenCalled();
  post.mockClear();
  await unmount.update({ reloadToken: 1 });
  await act(async () => { window.dispatchEvent(new Event('skills-changed')); });
  expect(post.mock.calls.every(([data]) => data.type === 'flowix:skill-market:probe')).toBe(true);
  await act(async () => { ready(); });
  expect(post).toHaveBeenCalled();
  await unmount();
});


it('connects before a slow native scan and does not restart scans for repeated ready messages', async () => {
  let resolveSkills!: (skills: { id: string }[]) => void;
  mocks.readNotebookAgentSkills.mockImplementationOnce(() => new Promise(resolve => { resolveSkills = resolve; }));
  const frame = document.createElement('iframe'); document.body.append(frame);
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  const unmount = await mountBridge(frame);
  await act(async () => {
    for (let i = 0; i < 3; i++) window.dispatchEvent(new MessageEvent('message', { origin, source: frame.contentWindow, data: { type: 'flowix:skill-market:ready' } }));
  });
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'flowix:skill-market:context', notebookId: 'A', notebookAvailable: true }), origin);
  expect(mocks.readNotebookAgentSkills).toHaveBeenCalledTimes(1);
  await act(async () => { resolveSkills([{ id: 'late-skill' }]); });
  expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ installedSkillIds: ['late-skill'] }), origin);
  await unmount();
});

for (const localOrigin of ['http://asset.localhost', 'null']) it(`installs remote archives from a trusted local page (${localOrigin})`, async () => {
  const frame = document.createElement('iframe'); document.body.append(frame);
  const unmount = await mountBridge(frame);
  await unmount.update({ origin: localOrigin, currentUrl: `${localOrigin === 'null' ? 'asset://localhost' : localOrigin}/Users/demo/skill-market-ui/prod/versions/1.0.0/index.html` });
  const message = (data: unknown, sender = localOrigin) => window.dispatchEvent(new MessageEvent('message', { origin: sender, source: frame.contentWindow, data }));
  await act(async () => { message({ type: 'flowix:skill-market:ready' }); });
  for (const kind of ['skill', 'template']) {
    const data = { type: `flowix:skill-market:${kind === 'skill' ? 'install' : 'install-template'}`, requestId: kind, notebookId: 'A', [kind]: { id: 'example', displayName: 'Example', archive: { url: `${origin}/${kind === 'skill' ? 'skills' : 'templates'}/archives/example.zip` } } };
    await act(async () => { message(data, 'https://evil.example'); });
    expect(mocks.installCodexProjectSkillZip).not.toHaveBeenCalled();
    expect(mocks.installNotebookTemplateZip).not.toHaveBeenCalled();
    await act(async () => { message(data); });
    if (kind === 'skill') expect(mocks.installCodexProjectSkillZip).toHaveBeenCalledWith('/A', 'example', expect.objectContaining({ url: `${origin}/skills/archives/example.zip` }));
    else expect(mocks.installNotebookTemplateZip).toHaveBeenCalledWith('/A', 'example', { url: `${origin}/templates/archives/example.zip` });
    vi.clearAllMocks();
  }
  await unmount();
});

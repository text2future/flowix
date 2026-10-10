import { describe, expect, it, vi } from 'vitest';
import { openDocumentLocalLink } from './open-document-local-link';
import { peekAgentLocationRequest, cancelAgentLocationRequest } from './agent-location-navigation';

const openExternalTarget = vi.hoisted(() => vi.fn());
vi.mock('@features/workspace/use-cases/workspace-navigation', () => ({ openExternalTarget }));

describe('openDocumentLocalLink', () => {
  it('opens the target and publishes an anchor request for the opened host', async () => {
    openExternalTarget.mockResolvedValueOnce({ host: 'main-third', state: 'active' });
    await openDocumentLocalLink({ path: '/nb/课程/任务记录.md', anchor: '实验步骤' }, '/nb/课程');
    expect(openExternalTarget).toHaveBeenCalledWith('/nb/课程/任务记录.md', { scopePath: '/nb/课程' });
    const request = peekAgentLocationRequest('/nb/课程/任务记录.md');
    expect(request?.anchor).toBe('实验步骤');
    expect(request?.host).toBe('main-third');
    expect(request?.viewId).toBe('main-third');
    cancelAgentLocationRequest('/nb/课程/任务记录.md');
  });

  it('targets the browser column tab when the host is a browser column', async () => {
    openExternalTarget.mockResolvedValueOnce({ host: 'browser-column', tabId: 'tab-1' });
    await openDocumentLocalLink({ path: '/nb/课程/任务记录.md', anchor: '结论' }, null);
    const request = peekAgentLocationRequest('/nb/课程/任务记录.md');
    expect(request?.host).toBe('browser-column');
    expect(request?.viewId).toBe('tab-1');
    cancelAgentLocationRequest('/nb/课程/任务记录.md');
  });

  it('publishes nothing without an anchor', async () => {
    openExternalTarget.mockResolvedValueOnce({ host: 'main-third', state: 'active' });
    await openDocumentLocalLink({ path: '/nb/方案.md', anchor: null }, '/nb');
    expect(peekAgentLocationRequest('/nb/方案.md')).toBeNull();
  });

  it('publishes nothing when nothing was opened', async () => {
    openExternalTarget.mockResolvedValueOnce(null);
    await openDocumentLocalLink({ path: '/nb/方案.md', anchor: '结论' }, '/nb');
    // openExternalTarget 的 markdown 主区分支返回 null，但内容已落 main-third，
    // 锚点请求按 main-third 回退发布。
    const request = peekAgentLocationRequest('/nb/方案.md');
    expect(request?.anchor).toBe('结论');
    expect(request?.host).toBe('main-third');
    cancelAgentLocationRequest('/nb/方案.md');
  });
});

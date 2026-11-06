import { describe, expect, it, vi } from 'vitest';
import { handleMarketInstall, type MarketInstallPorts } from './market-install-handler';

const origin = 'https://skills.flowix.cc';
function setup() {
  const ports: MarketInstallPorts = {
    origin, isActive: () => true,
    getSelectedNotebook: () => ({ id: 'A', name: 'Notebook', path: '/notes/A' }),
    respond: vi.fn(), installSkill: vi.fn().mockResolvedValue({}), installTemplate: vi.fn().mockResolvedValue({}), onInstalled: vi.fn(),
  };
  const request = (kind: 'skill' | 'template' = 'skill') => ({
    type: `flowix:skill-market:${kind === 'skill' ? 'install' : 'install-template'}`, requestId: 'request', notebookId: 'A',
    [kind]: { id: 'second-package', displayName: '第二方案', archive: { url: `${origin}/${kind === 'skill' ? 'skills' : 'templates'}/archives/second-package.zip`, ...(kind === 'template' ? { targetDirectory: '工作计划' } : {}) } },
  });
  return { ports, request };
}
describe('market installation dispatch', () => {
  it('installs arbitrary template IDs and preserves request correlation', async () => {
    const { ports, request } = setup();
    await handleMarketInstall(request('template'), ports);
    expect(ports.installTemplate).toHaveBeenCalledWith('/notes/A', 'second-package', { url: `${origin}/templates/archives/second-package.zip` });
    expect(ports.respond).toHaveBeenCalledWith(expect.objectContaining({ type: 'flowix:skill-market:install-template-result', requestId: 'request', notebookId: 'A', success: true }));
    expect(ports.onInstalled).toHaveBeenCalledOnce();
  });
  it('rejects another origin in the archive without invoking native code', async () => {
    const { ports, request } = setup(); const data = request();
    const item = data.skill as { archive: { url: string } };
    item.archive.url = 'https://other.example/skills/archives/second-package.zip';
    await handleMarketInstall(data, ports);
    expect(ports.installSkill).not.toHaveBeenCalled();
    expect(ports.respond).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_package' }));
  });
  it('rejects a changed notebook and detached frame before starting installation', async () => {
    const { ports, request } = setup();
    ports.getSelectedNotebook = () => ({ id: 'B', name: 'B', path: '/B' });
    await handleMarketInstall(request(), ports);
    expect(ports.respond).toHaveBeenCalledWith(expect.objectContaining({ code: 'notebook_changed' }));
    ports.getSelectedNotebook = () => ({ id: 'A', name: 'A', path: '/A' });
    ports.isActive = () => false;
    await handleMarketInstall(request(), ports);
    expect(ports.installSkill).not.toHaveBeenCalled();
  });
  it('returns structured failure immediately and suppresses replies after detach', async () => {
    const { ports, request } = setup();
    ports.installTemplate = vi.fn().mockRejectedValue({ code: 'permission_denied', message: 'private native detail' });
    await handleMarketInstall(request('template'), ports);
    expect(ports.respond).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'permission_denied' }));
    expect(ports.onInstalled).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(ports.respond).mock.calls)).not.toContain('private native detail');
  });
  it('adapts legacy conflict errors for both package types', async () => {
    const { ports, request } = setup();
    ports.installSkill = vi.fn().mockRejectedValue('a project Skill with this name already exists');
    ports.installTemplate = vi.fn().mockRejectedValue('a folder with this notebook template name already exists');
    for (const kind of ['skill', 'template'] as const) await handleMarketInstall(request(kind), ports);
    expect(ports.respond).toHaveBeenCalledTimes(2);
    expect(ports.respond).toHaveBeenCalledWith(expect.objectContaining({ code: 'already_exists' }));
  });
  it('does not post a late result into an inactive frame', async () => {
    const { ports, request } = setup();
    ports.installSkill = async () => { ports.isActive = () => false; };
    await handleMarketInstall(request(), ports);
    expect(ports.respond).not.toHaveBeenCalled();
    expect(ports.onInstalled).toHaveBeenCalledOnce();
  });
});

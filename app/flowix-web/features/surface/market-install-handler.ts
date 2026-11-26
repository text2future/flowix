import type { NotebookTemplateArchive, ProjectSkillArchive, ProjectSkillSource } from '@platform/tauri/client/agent';
import { isSkillInstallationUnavailable } from './skill-market-install-error';

export interface MarketNotebook { id: string; name: string; path: string; missing?: boolean }
export interface MarketInstallPorts {
  contentOrigin: string;
  isActive: () => boolean;
  getSelectedNotebook: () => MarketNotebook | null;
  respond: (message: Record<string, unknown>) => void;
  installSkill: (path: string, id: string, archive: ProjectSkillArchive) => Promise<unknown>;
  installTemplate: (path: string, id: string, archive: NotebookTemplateArchive) => Promise<unknown>;
  onInstalled: (kind: 'skill' | 'template', notebook: MarketNotebook) => void;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function validSource(value: unknown): value is ProjectSkillSource | undefined | null {
  return value == null || (isRecord(value)
    && typeof value.repository === 'string' && value.repository.length <= 200
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository)
    && typeof value.directory === 'string' && value.directory.length <= 512
    && (value.revision == null || (typeof value.revision === 'string' && /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value.revision))));
}
export function marketInstallFailure(error: unknown): { code: string } {
  if (isRecord(error) && typeof error.code === 'string') {
    const codes = ['already_exists', 'invalid_package', 'permission_denied', 'installation_failed', 'installation_unsupported'];
    return { code: codes.includes(error.code) ? error.code : 'installation_failed' };
  }
  // Compatibility with native commands predating structured installation errors.
  const message = error instanceof Error ? error.message : String(error);
  if (/already exists/i.test(message)) return { code: 'already_exists' };
  if (isSkillInstallationUnavailable(message)) return { code: 'installation_unsupported' };
  return { code: 'installation_failed' };
}

function validArchiveUrl(raw: unknown, contentOrigin: string, kind: 'skill' | 'template', id: string): raw is string {
  if (raw === `${contentOrigin}/${kind === 'skill' ? 'skills' : 'templates'}/archives/${id}.zip`) return true;
  if (typeof raw !== 'string') return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !['cloud.flowix.cc', 'staging-cloud.flowix.cc'].includes(url.hostname)
      || url.port || url.username || url.password || url.search || url.hash) return false;
    const parts = url.pathname.slice(1).split('/');
    const collection = kind === 'skill' ? 'skills' : 'templates';
    return parts.length === 9
      && parts[0] === 'v1' && parts[1] === 'market' && parts[2] === 'resources'
      && ['mainland', 'non_mainland'].includes(parts[3])
      && parts[4] === collection && parts[5] === id && parts[6] === 'archives'
      && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(parts[7])
      && /^[0-9a-f]{64}$/i.test(parts[8]);
  } catch { return false; }
}

/** Transport-independent installation dispatch. All replies preserve request and notebook IDs. */
export async function handleMarketInstall(data: unknown, ports: MarketInstallPorts): Promise<void> {
  if (!isRecord(data)) return;
  const kind = data.type === 'flowix:skill-market:install' ? 'skill'
    : data.type === 'flowix:skill-market:install-template' ? 'template' : null;
  if (!kind) return;
  const requestId = typeof data.requestId === 'string' && data.requestId.length <= 128 ? data.requestId : '';
  if (!requestId) return;
  const notebookId = typeof data.notebookId === 'string' ? data.notebookId : '';
  const respond = (result: Record<string, unknown>) => {
    if (ports.isActive()) ports.respond({ type: kind === 'skill' ? 'flowix:skill-market:install-result' : 'flowix:skill-market:install-template-result', requestId, notebookId, ...result });
  };
  if (!notebookId) { respond({ success: false, code: 'no_notebook' }); return; }
  const item = isRecord(data[kind]) ? data[kind] : null;
  const id = typeof item?.id === 'string' ? item.id : '';
  const displayName = typeof item?.displayName === 'string' ? item.displayName.trim() : '';
  const archive = isRecord(item?.archive) ? item.archive : null;
  const archiveUrl = archive?.url;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 64 || !displayName || displayName.length > 200
    || !validArchiveUrl(archiveUrl, ports.contentOrigin, kind, id)
    || (kind === 'skill' && !validSource(archive?.source))) {
    respond({ success: false, code: 'invalid_package' }); return;
  }
  const notebook = ports.getSelectedNotebook();
  if (!notebook?.path || notebook.missing || notebook.id !== notebookId) {
    respond({ success: false, code: 'notebook_changed' }); return;
  }
  // A detached frame must not start a native operation after asynchronous setup.
  if (!ports.isActive()) return;
  try {
    if (kind === 'skill') {
      await ports.installSkill(notebook.path, id, { url: archiveUrl, source: archive!.source as ProjectSkillSource | undefined | null });
    } else {
      await ports.installTemplate(notebook.path, id, { url: archiveUrl });
    }

  } catch (error) {
    console.error('Market installation failed:', error);
    respond({ success: false, ...marketInstallFailure(error) });
    return;
  }
  respond({ success: true, notebookName: notebook.name });
  try { ports.onInstalled(kind, notebook); }
  catch (error) { console.error('Failed to refresh market installation state:', error); }
}

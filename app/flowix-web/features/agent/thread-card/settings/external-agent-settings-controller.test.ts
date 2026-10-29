import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentTypeKey } from '@/types/agent';
import type { AppLanguage } from '@/lib/i18n';

const mocks = vi.hoisted(() => ({
  readSkills: vi.fn(), getFilter: vi.fn(), setFilter: vi.fn(), listNotes: vi.fn(),
  listTables: vi.fn(), readDocument: vi.fn(), parseTable: vi.fn(), toastError: vi.fn(),
  notebook: { id: 'book', path: '/book', missing: false },
}));
vi.mock('@platform/tauri/client', () => ({
  agent: { readNotebookAgentSkills: mocks.readSkills },
  system: { getFeaturedNoteFilter: mocks.getFilter, setFeaturedNoteFilter: mocks.setFilter },
  notes: { list: mocks.listNotes }, files: { listTableDocuments: mocks.listTables },
  externalDocuments: { read: mocks.readDocument }, windows: {},
}));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: vi.fn(() => vi.fn()) }));
vi.mock('@features/memo/store/note-store', () => ({ useNoteStore: { getState: () => ({
  selectedNotebook: mocks.notebook, notebooks: [mocks.notebook],
}) } }));
vi.mock('@features/memo/public/note-navigation-api', () => ({ openNoteByNotebookPath: vi.fn() }));
vi.mock('@features/multidimensional-table/parse-table-document', () => ({ parseTableDocumentAsync: mocks.parseTable }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.toastError } }));
import { ExternalAgentSettingsController } from './external-agent-settings-controller';
import { AgentEmptyStateController } from './agent-empty-state-controller';
import { ThreadMessageRenderController } from '../messages/thread-message-render-controller';
import { MessageViewportController } from '../messages/message-viewport-controller';

const cleanups: Array<() => void> = [];
let stored: { conditions: never[]; tableSelection: { relativePath: string; tableId: string } | null };
beforeEach(() => {
  vi.clearAllMocks();
  stored = { conditions: [], tableSelection: { relativePath: 'table.json', tableId: 'table' } };
  mocks.notebook = { id: 'book', path: '/book', missing: false };
  mocks.getFilter.mockImplementation(async () => stored);
  mocks.setFilter.mockImplementation(async (_id, next) => { stored = next; });
  mocks.readSkills.mockResolvedValue([{ id: 'review', name: 'Review', description: 'Review code', enabled: true }]);
  mocks.listNotes.mockResolvedValue([{ relativePath: 'hello.md', title: 'Hello', preview: 'Preview', properties: {}, icon: null }]);
  mocks.listTables.mockResolvedValue([{ relativePath: 'table.json', collectionId: 'table', name: 'Table' }]);
  mocks.readDocument.mockResolvedValue('table');
  mocks.parseTable.mockResolvedValue({ collection: { id: 'table' }, dataset: { records: { include: [{ note_path: 'hello.md' }] } } });
});
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function mount(presentation: 'expanded' | 'inline-card' = 'expanded') {
  const context: { type: AgentTypeKey; language: AppLanguage } = { type: 'codex', language: 'zh-CN' };
  const surface: { presentation: 'expanded' | 'inline-card' } = { presentation };
  const onNote = vi.fn(), onPrompt = vi.fn(), onSkill = vi.fn();
  const settings = new ExternalAgentSettingsController({
    popover: document.createElement('div'), getTypeKey: () => context.type,
    getInstanceId: () => undefined, getLanguage: () => context.language,
    getEmptyStatePresentation: () => surface.presentation,
    t: key => key, isDestroyed: () => false,
    onSelectFeaturedNote: onNote, onSelectEmptyPrompt: onPrompt, onSelectEmptySkill: onSkill,
  });
  const body = document.createElement('div'); document.body.append(body);
  const loadingIndicator = document.createElement('div'); body.append(loadingIndicator);
  const viewport = new MessageViewportController({
    body, bottomFollowThresholdPx: 64, topHistoryLoadThresholdPx: 64, scrollDeltaEpsilonPx: 2,
    isCollapsed: () => false, isFullscreen: () => true, getRuntimeThreadId: () => null,
    getConversationMessageState: () => null, loadMoreMessages: vi.fn(),
  });
  const renderer = new ThreadMessageRenderController({
    body, loadingIndicator, messageViewport: viewport, getLanguage: () => context.language,
    getTypeKey: () => context.type, t: key => key,
    createThreadCacheSkeleton: () => Object.assign(document.createElement('div'), { className: 'agent-thread-card__skeleton' }),
    createExternalAgentEmptySettings: () => settings.createEmptySettings(),
  });
  cleanups.push(() => { renderer.dispose(); settings.dispose(); viewport.dispose(); });
  const input = { messages: [], isLoading: false, shouldRenderMessages: true, isThreadCachePresentationHidden: false, isThreadCacheLoading: false };
  renderer.render(input);
  return { body, renderer, settings, input, context, surface, onNote, onPrompt, onSkill };
}
async function waitPanel(body: HTMLElement) {
  await vi.waitFor(() => expect(body.querySelector('.agent-thread-card__featured-note')).not.toBeNull());
}
it('keeps inline settings compact without querying expanded content', () => {
  const { body } = mount('inline-card');
  expect(body.querySelector('.agent-conversation__controls')).not.toBeNull();
  expect(body.querySelector('.agent-thread-card__empty-welcome')).toBeNull();
  expect(mocks.readSkills).not.toHaveBeenCalled();
  expect(mocks.listNotes).not.toHaveBeenCalled();
});
it('renders expanded guidance and table cards, preserving composer callbacks', async () => {
  const { body, onNote, onPrompt, onSkill } = mount(); await waitPanel(body);
  const empty = body.querySelector('.agent-thread-card__empty')!;
  expect(empty.querySelector('.agent-conversation__controls')).toBeNull();
  expect(empty.nextElementSibling?.className).toBe('agent-thread-card__featured-notes');
  body.querySelector<HTMLButtonElement>('.agent-thread-card__empty-prompt')!.click();
  body.querySelector<HTMLButtonElement>('.agent-thread-card__empty-skill')!.click();
  body.querySelector<HTMLButtonElement>('.agent-thread-card__featured-note')!.click();
  expect(onPrompt).toHaveBeenCalledOnce(); expect(onSkill).toHaveBeenCalledOnce();
  expect(onNote).toHaveBeenCalledWith(expect.objectContaining({ notebookId: 'book', relativePath: 'hello.md' }));
});
it.each(['message', 'hidden', 'history', 'dispose'] as const)('cleans the panel and detached popover on %s', async transition => {
  const { body, renderer, input } = mount(); await waitPanel(body);
  const panel = body.querySelector('.agent-thread-card__featured-notes')!;
  const popover = document.querySelector('.agent-thread-card__featured-notes-view-picker')!;
  if (transition === 'dispose') renderer.dispose();
  else renderer.render({ ...input,
    ...(transition === 'hidden' ? { shouldRenderMessages: false } : {}),
    ...(transition === 'history' ? { isInitialHistoryLoading: true } : {}),
    ...(transition === 'message' ? { messages: [{ id: 'u1', role: 'user' as const, content: 'hello', timestamp: '2026-01-01' }] } : {}),
  });
  expect(panel.isConnected).toBe(false); expect(popover.isConnected).toBe(false);
});
it('reuses the empty surface, requests and open popover on identical renders', async () => {
  const { body, renderer, input } = mount(); await waitPanel(body);
  const empty = body.querySelector('.agent-thread-card__empty');
  body.querySelector<HTMLButtonElement>('.agent-thread-card__featured-notes-settings-button')!.click();
  const popover = document.querySelector<HTMLElement>('.agent-thread-card__featured-notes-view-picker')!;
  const focused = document.activeElement;
  renderer.render(input); await Promise.resolve();
  expect(body.querySelector('.agent-thread-card__empty')).toBe(empty);
  expect(popover.isConnected).toBe(true); expect(popover.hidden).toBe(false);
  expect(document.activeElement).toBe(focused);
  expect(mocks.readSkills).toHaveBeenCalledTimes(1); expect(mocks.listNotes).toHaveBeenCalledTimes(1);
});
it.each(['notebook', 'language', 'agent'] as const)('recreates the empty surface when %s changes', async change => {
  const { body, renderer, input, context } = mount(); await waitPanel(body);
  const empty = body.querySelector('.agent-thread-card__empty');
  if (change === 'notebook') mocks.notebook = { id: 'other', path: '/other', missing: false };
  if (change === 'language') context.language = 'en-US';
  if (change === 'agent') context.type = 'claudecode';
  renderer.render(input); await waitPanel(body);
  expect(body.querySelector('.agent-thread-card__empty')).not.toBe(empty);
  expect(body.querySelectorAll('.agent-thread-card__featured-notes')).toHaveLength(1);
  expect(document.querySelectorAll('.agent-thread-card__featured-notes-view-picker')).toHaveLength(1);
});
it.each(['expanded', 'inline-card'] as const)(
  'rebuilds the empty surface when the presentation switches away from %s',
  async from => {
    const to = from === 'expanded' ? 'inline-card' : 'expanded';
    const { body, renderer, input, surface } = mount(from);
    if (from === 'expanded') await waitPanel(body);
    const empty = body.querySelector('.agent-thread-card__empty')!;
    surface.presentation = to;
    renderer.render(input);
    const next = body.querySelector('.agent-thread-card__empty')!;
    expect(next).not.toBe(empty);
    expect(next.classList.contains(`agent-thread-card__empty--${to}`)).toBe(true);
    expect(next.classList.contains(`agent-thread-card__empty--${from}`)).toBe(false);
    // 每种形态只保留自己的内容: 内联态是运行时设置行, 展开态是欢迎指引。
    expect(next.querySelector('.agent-conversation__controls') !== null).toBe(to === 'inline-card');
    expect(next.querySelector('.agent-thread-card__empty-welcome') !== null).toBe(to === 'expanded');
    // 展开态的常用笔记面板跟随形态销毁/重建, 不留孤儿面板或弹层。
    if (to === 'inline-card') {
      expect(body.querySelector('.agent-thread-card__featured-notes')).toBeNull();
      expect(document.querySelector('.agent-thread-card__featured-notes-view-picker')).toBeNull();
      return;
    }
    await waitPanel(body);
    expect(body.querySelectorAll('.agent-thread-card__featured-notes')).toHaveLength(1);
    expect(document.querySelectorAll('.agent-thread-card__featured-notes-view-picker')).toHaveLength(1);
  },
);
it('does not mount late results after leaving the empty state', async () => {
  let resolve!: (value: typeof stored) => void;
  mocks.getFilter.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const { body, renderer, input } = mount();
  renderer.render({ ...input, shouldRenderMessages: false });
  resolve(stored); await new Promise(r => setTimeout(r, 0));
  expect(body.querySelector('.agent-thread-card__featured-notes')).toBeNull();
  expect(document.querySelector('.agent-thread-card__featured-notes-view-picker')).toBeNull();
});
it('persists a table selection and refreshes the cards', async () => {
  const { body } = mount(); await waitPanel(body);
  document.querySelector<HTMLButtonElement>('.agent-thread-card__featured-notes-view-option')!.click();
  await vi.waitFor(() => expect(mocks.setFilter).toHaveBeenCalledWith('book', { conditions: [], tableSelection: { relativePath: 'table.json', tableId: 'table' } }));
  await vi.waitFor(() => expect(mocks.listNotes).toHaveBeenCalledTimes(2));
  expect(document.querySelectorAll('.agent-thread-card__featured-notes-view-picker')).toHaveLength(1);
});
it('keeps the selected cards and allows retry when saving fails', async () => {
  const { body } = mount(); await waitPanel(body);
  mocks.setFilter.mockRejectedValueOnce(new Error('disk'));
  const option = document.querySelector<HTMLButtonElement>('.agent-thread-card__featured-notes-view-option')!;
  option.click();
  await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
  expect(option.disabled).toBe(false);
  expect(body.querySelector('.agent-thread-card__featured-note')).not.toBeNull();
});
it('rebuilds guidance once history finishes with no messages', async () => {
  const { body, renderer, input } = mount();
  renderer.render({ ...input, isInitialHistoryLoading: true });
  expect(body.querySelector('.agent-thread-card__skeleton')).not.toBeNull();
  renderer.render(input);
  await waitPanel(body);
  expect(body.querySelector('.agent-thread-card__skeleton')).toBeNull();
  expect(body.querySelectorAll('.agent-thread-card__empty')).toHaveLength(1);
});
it('ignores an old skill response after the notebook changes', async () => {
  let resolve!: (skills: unknown[]) => void;
  mocks.readSkills.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const { body, renderer, input } = mount();
  mocks.notebook = { id: 'other', path: '/other', missing: false };
  renderer.render(input);
  await waitPanel(body);
  resolve([{ id: 'old', name: 'Obsolete skill', enabled: true }]);
  await new Promise(r => setTimeout(r, 0));
  expect(body.textContent).toContain('Review');
  expect(body.textContent).not.toContain('Obsolete skill');
});
it('only refreshes skills for the mounted notebook and removes its subscription on exit', async () => {
  const { body, renderer, input } = mount();
  await waitPanel(body);
  const dispatch = (notebookId: string) => window.dispatchEvent(new CustomEvent(
    'flowix:notebook-agent-skills-changed', { detail: { notebookId } },
  ));
  dispatch('unrelated');
  expect(mocks.readSkills).toHaveBeenCalledTimes(1);
  dispatch('book');
  await vi.waitFor(() => expect(mocks.readSkills).toHaveBeenCalledTimes(2));
  renderer.render({ ...input, shouldRenderMessages: false });
  dispatch('book');
  expect(mocks.readSkills).toHaveBeenCalledTimes(2);
  renderer.render(input);
  await waitPanel(body);
  dispatch('book');
  await vi.waitFor(() => expect(mocks.readSkills).toHaveBeenCalledTimes(4));
});
it('keeps horizontal and body scroll positions during an unchanged render', async () => {
  const { body, renderer, input } = mount();
  await waitPanel(body);
  const list = body.querySelector<HTMLElement>('.agent-thread-card__featured-notes-list')!;
  list.scrollLeft = 120;
  body.scrollTop = 80;
  renderer.render(input);
  expect(list.scrollLeft).toBe(120);
  expect(body.scrollTop).toBe(80);
});
it('does not let a completed save from an old panel cancel the new panel load', async () => {
  const { body, renderer, input } = mount();
  await waitPanel(body);
  let finishSave!: () => void;
  mocks.setFilter.mockImplementationOnce(() => new Promise<void>(resolve => { finishSave = resolve; }));
  document.querySelector<HTMLButtonElement>('.agent-thread-card__featured-notes-view-option')!.click();
  await vi.waitFor(() => expect(mocks.setFilter).toHaveBeenCalledOnce());
  renderer.render({ ...input, shouldRenderMessages: false });
  let finishRead!: (value: typeof stored) => void;
  mocks.getFilter.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  renderer.render(input);
  const reads = mocks.getFilter.mock.calls.length;
  finishSave();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(mocks.getFilter).toHaveBeenCalledTimes(reads);
  finishRead(stored);
  await waitPanel(body);
  expect(body.querySelectorAll('.agent-thread-card__featured-notes')).toHaveLength(1);
});

function mountEmptyContent(type: AgentTypeKey, notebookPath: string | null) {
  const onSkill = vi.fn();
  const onMore = vi.fn();
  const controller = new AgentEmptyStateController({
    getTypeKey: () => type,
    getInstanceId: () => undefined,
    getLanguage: () => 'zh-CN',
    getPresentation: () => 'expanded',
    getNotebookId: () => null,
    getNotebookPath: () => notebookPath,
    t: key => key,
    isDestroyed: () => false,
    onSelectEmptySkill: onSkill,
    onOpenEmptySkills: onMore,
    appendRuntimeSettings: vi.fn(),
    refreshRuntimeSettings: vi.fn(),
    clearRuntimeSettings: vi.fn(),
  });
  cleanups.push(() => controller.dispose());
  const root = controller.create();
  document.body.append(root);
  return { root, onSkill, onMore };
}

it('finishes the skills loading state when no notebook is available', async () => {
  const { root } = mountEmptyContent('codex', null);
  await vi.waitFor(() => expect(root.querySelector('.agent-thread-card__empty-skill-hint')).not.toBeNull());
  expect(root.querySelector('[aria-busy="true"]')).toBeNull();
  expect(mocks.readSkills).not.toHaveBeenCalled();
});

it('preserves Pi skill command names and the overflow entry after extraction', async () => {
  mocks.readSkills.mockResolvedValue(Array.from({ length: 7 }, (_, i) => ({
    id: `skill-${i}`, commandName: `command-${i}`, name: `Skill ${i}`,
    description: 'Description', enabled: true,
  })));
  const { root, onSkill, onMore } = mountEmptyContent('pi', '/book');
  await vi.waitFor(() => expect(root.querySelectorAll('.agent-thread-card__empty-skill')).toHaveLength(6));
  root.querySelector<HTMLButtonElement>('.agent-thread-card__empty-skill')!.click();
  expect(onSkill).toHaveBeenCalledWith(expect.objectContaining({ name: 'command-0', displayName: 'Skill 0' }));
  root.querySelector<HTMLButtonElement>('.agent-thread-card__empty-skill--more')!.click();
  expect(onMore).toHaveBeenCalledOnce();
});

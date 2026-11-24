import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/lib/i18n';

import { MassDeletionDialog } from './mass-deletion-dialog';

const mocks = vi.hoisted(() => ({
  resolveMassDeletion: vi.fn().mockResolvedValue(undefined),
  toastError: vi.fn(),
}));

vi.mock('@/platform/tauri/client/cloud', () => ({
  cloud: { resolveMassDeletion: mocks.resolveMassDeletion },
}));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.toastError } }));

// The dialog remembers answers for the session, so each case starts from a
// clean slate instead of inheriting the previous one's confirmation.
beforeEach(() => {
  window.sessionStorage.clear();
  mocks.resolveMassDeletion.mockClear();
  mocks.toastError.mockClear();
});

function render(props: { localCount: number; remoteCount: number }) {
  return (
    <I18nProvider language="zh-CN">
      <MassDeletionDialog notebookId="nb_1" {...props} />
    </I18nProvider>
  );
}

// DialogContent renders through a portal on `document.body`, so the local
// container stays empty no matter what the dialog shows.
function clickButton(label: string) {
  const button = [...document.body.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button, `button "${label}"`).toBeDefined();
  return button!;
}

it('stays quiet until a pass reports a bulk deletion', async () => {
  const element = document.createElement('div');
  const root = createRoot(element);
  try {
    await act(async () => root.render(render({ localCount: 0, remoteCount: 0 })));
    expect(document.body.textContent).not.toContain('大量文档被删除');
  } finally {
    await act(async () => root.unmount());
  }
});

it('asks before deleting the local copies and undoes through the same button', async () => {
  const element = document.createElement('div');
  const root = createRoot(element);
  try {
    await act(async () => root.render(render({ localCount: 4, remoteCount: 0 })));
    // The direction decides the sentence: these files exist here and the cloud
    // already deleted them, so the risk is on this device.
    expect(document.body.textContent).toContain('云端已删除 4 个文档');
    expect(document.body.textContent).toContain('确认删除后，被删除内容不可恢复');
    // Undo is not "do nothing": it puts the copies back in the cloud.
    expect(document.body.textContent).toContain('保留本机文件，并重新上传到云端');

    await act(async () => clickButton('撤销删除').click());
    expect(mocks.resolveMassDeletion).toHaveBeenCalledWith('nb_1', true);
  } finally {
    await act(async () => root.unmount());
  }
});

it('warns about the cloud copies when the deletions happened here', async () => {
  const element = document.createElement('div');
  const root = createRoot(element);
  try {
    await act(async () => root.render(render({ localCount: 0, remoteCount: 6 })));
    expect(document.body.textContent).toContain('本机有 6 个文档被删除');
    // Undo here downloads the cloud copies back onto this device, so the files
    // the user just deleted reappear.
    expect(document.body.textContent).toContain('从云端恢复到本机，删除的文件会重新出现');

    await act(async () => clickButton('确认').click());
    expect(mocks.resolveMassDeletion).toHaveBeenCalledWith('nb_1', false);
  } finally {
    await act(async () => root.unmount());
  }
});

it('describes a batch that points both ways without picking one', async () => {
  const element = document.createElement('div');
  const root = createRoot(element);
  try {
    await act(async () => root.render(render({ localCount: 2, remoteCount: 3 })));
    expect(document.body.textContent).toContain('本机有 5 个文档与云端不一致');
  } finally {
    await act(async () => root.unmount());
  }
});

it('keeps the answered batch quiet across a remount but asks about a different one', async () => {
  const first = document.createElement('div');
  const firstRoot = createRoot(first);
  await act(async () => firstRoot.render(render({ localCount: 30, remoteCount: 0 })));
  await act(async () => clickButton('确认').click());
  await act(async () => firstRoot.unmount());

  // Switching to another notebook and back unmounts this dialog; the question
  // the user just answered must not be asked a second time.
  const second = document.createElement('div');
  const secondRoot = createRoot(second);
  try {
    await act(async () => secondRoot.render(render({ localCount: 30, remoteCount: 0 })));
    expect(document.body.textContent).not.toContain('大量文档被删除');

    // A larger batch is a different question, so it is asked.
    await act(async () => secondRoot.render(render({ localCount: 31, remoteCount: 0 })));
    expect(document.body.textContent).toContain('云端已删除 31 个文档');
  } finally {
    await act(async () => secondRoot.unmount());
  }
});

'use client';

import { useRef, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import {
  NotebookCreateFooter,
  NotebookCreateForm,
  NotebookAgentLibraryHint,
  createNotebookRegistration, notebookRepository, useNoteStore,
  DEFAULT_NOTEBOOK_ICON_ID,
} from '@features/memo/public/onboarding-api';
import { dialogs, notebooks, type NotebookRecord, type ObsidianVaultRecord } from '@platform/tauri/client';
import { useI18n } from '@/lib/i18n';
import { Dialog, DialogContent } from '@shared/ui/dialog';
import { useTauriRpc } from '@platform/tauri/use-tauri-rpc';
import { attachNotebookFolder } from '@features/agent/public/workspace-api';
import { useShortcutScope } from '@features/shortcuts';
import { toast } from '@/lib/toast';

interface OnboardingScreenProps {
  onFinish(notebook: NotebookRecord, options: { startImport: boolean }): Promise<void>;
}

export function OnboardingScreen({ onFinish }: OnboardingScreenProps) {
  const { t, language } = useI18n();
  useShortcutScope('dialog');
  const { request } = useTauriRpc();
  const inFlight = useRef(false);
  const [paths, setPaths] = useState<string[]>([]);
  const [vaults, setVaults] = useState<ObsidianVaultRecord[]>([]);
  const [vaultsLoading, setVaultsLoading] = useState(false);
  const [vaultsError, setVaultsError] = useState(false);
  const [notebookName, setNotebookName] = useState(() => language === 'en-US' ? 'My Notebook' : '我的笔记本');
  const [notebookIcon, setNotebookIcon] = useState<string | null>(DEFAULT_NOTEBOOK_ICON_ID);
  const [createdNotebook, setCreatedNotebook] = useState<NotebookRecord | null>(null);
  const [shouldStartImport, setShouldStartImport] = useState(false);
  const [isCreatingNotebook, setIsCreatingNotebook] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addPath = (path: string) => {
    setPaths((current) => current.includes(path) ? current : [...current, path]);
    setError(null);
  };
  const loadVaults = async () => {
    setVaultsLoading(true);
    setVaultsError(false);
    try { setVaults(await notebooks.listObsidianVaults()); }
    catch { setVaultsError(true); }
    finally { setVaultsLoading(false); }
  };

  const importProject = async (source: 'workbuddy' | 'codex') => {
    try {
      const path = await request<string | null>('select_project_directory', { projectSource: source });
      if (path) addPath(path);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const finishNotebook = async (
    notebook: NotebookRecord,
    startImport: boolean,
  ) => {
    setIsFinishing(true);
    setError(null);
    try {
      await onFinish(notebook, { startImport });
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setIsFinishing(false);
    }
  };

  const createNotebook = async () => {
    if (inFlight.current) return;
    if (createdNotebook) {
      inFlight.current = true;
      try { await finishNotebook(createdNotebook, shouldStartImport); }
      finally { inFlight.current = false; }
      return;
    }

    const name = notebookName.trim();
    if (!name) return;
    inFlight.current = true;
    setIsCreatingNotebook(true);
    setError(null);
    try {
      const registration = await createNotebookRegistration({
        name,
        path: paths[0],
        icon: notebookIcon,
        reuseExisting: true,
      });

      const notebook = registration.notebook;
      const store = useNoteStore.getState();
      store.setNotebooks(store.notebooks.some((item) => item.id === notebook.id)
        ? store.notebooks.map((item) => item.id === notebook.id ? notebook : item)
        : [...store.notebooks, notebook]);
      const startImport = registration.needsImport;
      setCreatedNotebook(notebook);
      setShouldStartImport(startImport);
      for (const path of paths.slice(1)) {
        try {
          const attached = await attachNotebookFolder(notebook.id, path);
          if (attached === false) toast.error(t('agent.access.saveFailed'));
        } catch { toast.error(t('agent.access.saveFailed')); }
      }
      await finishNotebook(notebook, startImport);
      void notebookRepository.list()
        .then((latest) => useNoteStore.getState().setNotebooks(latest))
        .catch((value) => console.warn('[Onboarding] Failed to refresh notebook list:', value));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      inFlight.current = false;
      setIsCreatingNotebook(false);
    }
  };

  const selectNotebookDirectory = async () => {
    try {
      const path = await dialogs.selectDirectory();
      if (path) addPath(path);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        trapFocus
        overlayClassName="bg-white/65 backdrop-blur-[14px] dark:bg-black/45"
        className="max-h-[min(720px,calc(100dvh-2rem))] w-[min(576px,calc(90vw-1.8rem))] max-w-none overflow-y-auto rounded-[28px] border border-[var(--border-popup)] bg-[var(--card)] p-0 text-[var(--foreground)] shadow-[0_22px_70px_rgba(15,23,42,0.16)] [--onboarding-ink:var(--foreground)] [--onboarding-subtle:var(--muted-foreground)]"
      >
        <div role="dialog" aria-modal="true" aria-labelledby="flowix-onboarding-notebook-form-title" className="px-5 py-3">
          <NotebookCreateForm
            variant="dialog"
            title="创建笔记本"
            formId="flowix-onboarding-notebook-form"
            name={notebookName}
            onNameChange={setNotebookName}
            nameLabel={t('notebook.create.namePlaceholder')}
            namePlaceholder={t('notebook.create.namePlaceholder')}
            pathLabel={t('notebook.create.pathLabel')}
            pathLocationLabel={t('notebook.create.pathLocationDevice')}
            emptyPathPrimaryPrompt={t('notebook.create.emptyPathPrimaryPrompt')}
            emptyPathAlternativePrompt={t('notebook.create.emptyPathAlternativePrompt')}
            addFolderLabel={t('notebook.create.addFolder')}
            importLabel={t('memo.fileTree.import')}
            importWorkBuddyProjectLabel={t('notebook.create.importWorkBuddyProject')}
            importCodexProjectLabel={t('notebook.create.importCodexProject')}
            onImportProject={(source) => void importProject(source)}
            importObsidianVaultLabel={t('notebook.create.importObsidianVaults')}
            obsidianVaults={vaults}
            obsidianVaultsLoading={vaultsLoading}
            obsidianVaultsError={vaultsError}
            onImportObsidianVaults={() => void loadVaults()}
            onSelectObsidianVault={(vault) => addPath(vault.path)}
            primaryFolderLabel={t('notebook.create.primaryFolder')}
            setPrimaryFolderLabel={t('notebook.create.setPrimaryFolder')}
            removeFolderLabel={t('notebook.create.removeFolder')}
            selectedPaths={paths}
            path={paths[0] ?? ''}
            pathPlaceholder={t('notebook.create.pathPlaceholder')}
            directoryButtonLabel={t('notebook.create.selectDirectory')}
            onSelectDirectory={() => void selectNotebookDirectory()}
            onRemoveDirectory={(path) => setPaths((current) => current.filter((item) => item !== path))}
            onSetPrimaryDirectory={(path) => {
              setPaths((current) => current.includes(path)
                ? [path, ...current.filter((item) => item !== path)]
                : current);
            }}
            icon={notebookIcon}
            onIconChange={setNotebookIcon}
            disabled={Boolean(createdNotebook) || isCreatingNotebook || isFinishing}
            onSubmit={() => void createNotebook()}
          />
          <NotebookAgentLibraryHint />
          {error && <div className="mt-5 flex items-start gap-2 text-xs text-[var(--destructive)]" role="alert"><CircleAlert size={15} aria-hidden="true" />{error}</div>}
          <NotebookCreateFooter
            variant="dialog"
            formId="flowix-onboarding-notebook-form"
            disabled={!notebookName.trim()}
            isBusy={isCreatingNotebook || isFinishing}
            submitLabel={createdNotebook ? t('error.retry') : '创建并开始使用'}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

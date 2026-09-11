import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Plug } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import iconCodex from '@/assets/codex.svg';
import iconClaudeCode from '@/assets/icon-claude-code.svg';
import iconFlowixAgent from '@/assets/flowix-agent.svg';
import iconOpenCode from '@/assets/icon-opencode.svg';
import { Button } from '@shared/ui/button';
import { DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { UpdateProgress } from '@shared/ui/update-progress';
import { FloatingPrompt } from '@features/shell/components/floating-prompt';
import {
  AgentIcon,
  getLocalAgentRuntimeStatus,
} from '@features/agent/public/dsh-onboarding-api';
import { useCliLinkStatusStore } from '@features/preferences/store';
import type { DshRuntimeInstallerState } from '@features/preferences/public/system-api';

const LOCAL_AGENT_INTRO_OPTIONS = [
  { key: 'codex', nameKey: 'agent.types.codex.name', icon: iconCodex },
  { key: 'claude', nameKey: 'agent.types.claude.name', icon: iconClaudeCode },
  { key: 'opencode', nameKey: 'agent.types.opencode.name', icon: iconOpenCode },
] as const;
type LocalAgentIntroOption = (typeof LOCAL_AGENT_INTRO_OPTIONS)[number];

export function DshInstallPrompt({
  open,
  installer,
  onClose,
  onIntroDisplayed,
  onInstalled,
}: {
  open: boolean;
  installer: DshRuntimeInstallerState;
  onClose: () => void;
  onIntroDisplayed: () => void;
  onInstalled: () => void;
}) {
  const { t } = useI18n();
  const { busy, error, progress, install, cancel } = installer;
  const canCancel = busy && progress?.phase !== 'downloaded' && progress?.phase !== 'installing';
  const [slide, setSlide] = useState<'mcp' | 'intro' | 'download'>('mcp');
  const [mcpCopied, setMcpCopied] = useState(false);
  const [checkingLocalAgents, setCheckingLocalAgents] = useState(false);
  const [localAgent, setLocalAgent] = useState<LocalAgentIntroOption | null>(null);
  const lastToastedInstallErrorRef = useRef<string | null>(null);
  const cliStatus = useCliLinkStatusStore((state) => state.status);
  const refreshCliStatus = useCliLinkStatusStore((state) => state.refreshIfStale);

  useEffect(() => {
    if (!open) return;
    void refreshCliStatus();
  }, [open, refreshCliStatus]);

  useEffect(() => {
    if (!open || !error) {
      lastToastedInstallErrorRef.current = null;
      return;
    }
    if (error && error !== lastToastedInstallErrorRef.current) {
      lastToastedInstallErrorRef.current = error;
      toast.error(`${t('preferences.dsh.setup.error')}: ${error}`);
    }
  }, [error, open, t]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCheckingLocalAgents(true);
    setLocalAgent(null);
    void getLocalAgentRuntimeStatus()
      .then((status) => {
        if (cancelled) return;
        const detected = LOCAL_AGENT_INTRO_OPTIONS.find(({ key }) => status[key]?.available);
        setLocalAgent(detected ?? null);
      })
      .catch(() => {
        if (!cancelled) setLocalAgent(null);
      })
      .finally(() => {
        if (!cancelled) setCheckingLocalAgents(false);
      });
    return () => { cancelled = true; };
  }, [open]);

  const handleInstall = async () => {
    onIntroDisplayed();
    const status = await install();
    if (status) {
      toast.success(t('preferences.dsh.setup.installSuccess'));
      onInstalled();
    }
  };

  const handleCancel = async () => {
    if (await cancel()) toast.info(t('preferences.dsh.setup.cancelled'));
  };

  const handleCopyMcp = async () => {
    try {
      await navigator.clipboard.writeText(t('preferences.dsh.setup.mcp.copyContent', {
        command: cliStatus?.commandPath || 'flowix',
      }));
      setMcpCopied(true);
      toast.success(t('preferences.mcp.copied'));
      window.setTimeout(() => setMcpCopied(false), 1600);
    } catch {
      toast.error(t('preferences.mcp.copyFailed'));
    }
  };

  return (
    <FloatingPrompt open={open} onClose={onClose} className="max-h-[calc(100vh-2rem)] p-0">
        <div className="px-5 py-5 text-left">
          <div
            className="mb-5 flex items-center gap-1.5"
            role="tablist"
            aria-label={t('preferences.dsh.setup.carousel')}
          >
            <button
              type="button"
              role="tab"
              aria-selected={slide === 'mcp'}
              aria-label={t('preferences.dsh.setup.mcp.slide')}
              onClick={() => setSlide('mcp')}
              className={`h-1.5 rounded-full transition-[width,background-color] ${slide === 'mcp' ? 'w-7 bg-[var(--primary)]' : 'w-3 bg-[var(--muted)]'}`}
            />
            <button
              type="button"
              role="tab"
              aria-selected={slide === 'intro'}
              aria-label={t('preferences.dsh.setup.intro.slide')}
              onClick={() => setSlide('intro')}
              className={`h-1.5 rounded-full transition-[width,background-color] ${slide === 'intro' ? 'w-7 bg-[var(--primary)]' : 'w-3 bg-[var(--muted)]'}`}
            />
            <button
              type="button"
              role="tab"
              aria-selected={slide === 'download'}
              aria-label={t('preferences.dsh.setup.download.slide')}
              onClick={() => setSlide('download')}
              className={`h-1.5 rounded-full transition-[width,background-color] ${slide === 'download' ? 'w-7 bg-[var(--primary)]' : 'w-3 bg-[var(--muted)]'}`}
            />
          </div>

          <div
            className="relative overflow-hidden"
            aria-live="polite"
          >
            <div
              className="flex w-[300%] items-start transition-transform duration-300 ease-out will-change-transform"
              style={{
                transform: slide === 'mcp'
                  ? 'translateX(0)'
                  : slide === 'intro'
                    ? 'translateX(-33.333333%)'
                    : 'translateX(-66.666667%)',
              }}
            >
              <section className="w-1/3 shrink-0" aria-hidden={slide !== 'mcp'}>
                <DialogHeader className="mb-0">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[color-mix(in_oklch,var(--primary)_12%,transparent)] text-[var(--primary)]">
                    <Plug className="h-7 w-7" aria-hidden="true" />
                  </div>
                  <DialogTitle className="mt-3 text-base">
                    {t('preferences.dsh.setup.mcp.title')}
                  </DialogTitle>
                  <DialogDescription className="mt-1 whitespace-pre-line text-xs leading-5">
                    {t('preferences.dsh.setup.mcp.description')}
                  </DialogDescription>
                </DialogHeader>
              </section>

              <section className="w-1/3 shrink-0" aria-hidden={slide !== 'intro'}>
                <DialogHeader className="mb-0">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[color-mix(in_oklch,var(--primary)_12%,transparent)]">
                    <img
                      src={checkingLocalAgents ? iconFlowixAgent : localAgent?.icon ?? iconFlowixAgent}
                      alt=""
                      className="h-7 w-7 object-contain"
                    />
                  </div>
                  <DialogTitle className="mt-3 text-base">
                    {checkingLocalAgents
                      ? t('preferences.dsh.setup.intro.checking')
                      : localAgent
                        ? t('preferences.dsh.setup.intro.detected', { agent: t(localAgent.nameKey) })
                        : t('preferences.dsh.setup.intro.none')}
                  </DialogTitle>
                  {!checkingLocalAgents && (
                    <DialogDescription className="mt-1 whitespace-pre-line text-xs leading-5">
                      {t(
                        localAgent
                          ? 'preferences.dsh.setup.intro.description'
                          : 'preferences.dsh.setup.intro.noAgentDescription',
                      )}
                    </DialogDescription>
                  )}
                </DialogHeader>
              </section>

              <section className="w-1/3 shrink-0" aria-hidden={slide !== 'download'}>
                <DialogHeader className="mb-0">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[color-mix(in_oklch,var(--primary)_12%,transparent)]">
                    <AgentIcon typeKey="deepseek-harness" alt="" className="h-7 w-7" />
                  </div>
                  <DialogTitle className="mt-3 text-base">
                    {t('preferences.dsh.setup.promptTitle')}
                  </DialogTitle>
                  <DialogDescription className="mt-1 whitespace-pre-line text-xs leading-5">
                    {t('preferences.dsh.setup.promptDescription')}
                  </DialogDescription>
                </DialogHeader>

                {busy && progress && (
                  <UpdateProgress
                    className="mt-5 text-left"
                    value={progress}
                    label={t(progress.phase === 'installing' ? 'preferences.dsh.setup.installing' : 'preferences.dsh.setup.downloading')}
                    resumedLabel={t('preferences.dsh.setup.resumed')}
                  />
                )}

              </section>
            </div>
          </div>

          <div className="relative mt-6 min-h-8">
            <div
              className={`absolute inset-y-0 right-0 flex items-center gap-2 transition-opacity duration-200 ${slide === 'mcp' ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
              aria-hidden={slide !== 'mcp'}
            >
              <Button type="button" variant="outline" onClick={() => void handleCopyMcp()}>
                {mcpCopied && <Check className="h-4 w-4" />}
                {mcpCopied ? t('preferences.mcp.copied') : t('preferences.mcp.copy')}
              </Button>
              <Button type="button" onClick={() => setSlide('intro')}>
                {t('preferences.dsh.setup.next')}
              </Button>
            </div>
            <div
              className={`absolute inset-y-0 right-0 flex items-center gap-2 transition-opacity duration-200 ${slide === 'intro' ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
              aria-hidden={slide !== 'intro'}
            >
              <Button type="button" variant="outline" onClick={() => setSlide('mcp')}>
                {t('preferences.dsh.setup.previous')}
              </Button>
              <Button type="button" onClick={() => setSlide('download')}>
                {t('preferences.dsh.setup.next')}
              </Button>
            </div>
            <div
              className={`absolute inset-y-0 right-0 flex items-center gap-2 transition-opacity duration-200 ${slide === 'download' ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
              aria-hidden={slide !== 'download'}
            >
              <Button type="button" variant="outline" onClick={() => setSlide('intro')}>
                {t('preferences.dsh.setup.previous')}
              </Button>
              <Button type="button" onClick={() => void handleInstall()} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {busy ? t(progress?.phase === 'installing' ? 'preferences.dsh.setup.installing' : 'preferences.dsh.setup.downloading') : t('preferences.dsh.setup.install')}
              </Button>
              {canCancel && (
                <Button type="button" variant="outline" onClick={() => void handleCancel()}>
                  {t('preferences.dsh.setup.cancel')}
                </Button>
              )}
            </div>
          </div>
        </div>
    </FloatingPrompt>
  );
}

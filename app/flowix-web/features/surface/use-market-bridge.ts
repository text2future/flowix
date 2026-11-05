import { useEffect, type RefObject } from 'react';
import { agent, product } from '@platform/tauri/client';
import { getSelectedNotebookSnapshot, subscribeSelectedNotebook } from '@features/memo/public/selected-notebook-api';
import { NOTEBOOK_SKILLS_CHANGED_EVENT, notifyNotebookSkillsChanged } from '@features/agent/public/notebook-skills-api';
import { toast } from '@/lib/toast';
import { handleMarketInstall, isRecord } from './market-install-handler';

const TEMPLATES_CHANGED = 'flowix:notebook-templates-changed';
export function useMarketBridge({ iframeRef, origin: skillMarketOrigin, currentUrl, reloadToken, language, onReady }: {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  origin: string | null;
  currentUrl: string;
  reloadToken: number;
  language: string;
  onReady: () => void;
}) {
  useEffect(() => {
    const frame = iframeRef.current;
    if (!skillMarketOrigin || !frame) return;
    const sendTheme = () => {
      const target = frame.contentWindow;
      if (!target) return;
      try {
        // An iframe starts as same-origin about:blank while its cross-origin
        // navigation is pending. Don't post to that document with the market
        // origin as the target; it produces a postMessage origin error.
        if (target.location.origin !== skillMarketOrigin) return;
      } catch {
        // Reading location is blocked once the expected cross-origin page loads.
      }
      const root = document.documentElement;
      const style = getComputedStyle(root);
      const colors: Record<string, string> = {};
      for (const token of ['background', 'document-bg', 'foreground', 'document-foreground', 'card', 'muted', 'muted-foreground', 'hover-bg', 'border', 'primary', 'primary-foreground', 'ring']) {
        const value = style.getPropertyValue(`--${token}`).trim();
        if (value) colors[token] = value;
      }
      target.postMessage({ type: 'flowix:skill-market:language', language }, skillMarketOrigin);
      target.postMessage({
        type: 'flowix:skill-market:theme',
        colorScheme: style.colorScheme.includes('dark') ? 'dark' : 'light',
        colors,
      }, skillMarketOrigin);
    };
    const handleReady = (event: MessageEvent<unknown>) => {
      if (event.origin === skillMarketOrigin && event.source === frame.contentWindow
        && isRecord(event.data) && event.data.type === 'flowix:skill-market:ready') sendTheme();
    };
    const observer = new MutationObserver(sendTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
    frame.addEventListener('load', sendTheme);
    window.addEventListener('message', handleReady);
    sendTheme();
    return () => {
      observer.disconnect();
      frame.removeEventListener('load', sendTheme);
      window.removeEventListener('message', handleReady);
    };
  }, [iframeRef, currentUrl, skillMarketOrigin, reloadToken, language]);

  useEffect(() => {
    const frame = iframeRef.current;
    if (!skillMarketOrigin || !frame?.contentWindow) return;
    let active = true;
    let generation = 0;
    const appVersionPromise = Promise.resolve()
      .then(() => product.getInfo())
      .then(info => info.version)
      .catch(() => null);
    const sendMarketContext = async () => {
      const requestGeneration = ++generation;
      const notebook = getSelectedNotebookSnapshot();
      const available = Boolean(notebook?.path && !notebook.missing);
      const [appVersion, skills, templates] = await Promise.allSettled([
        appVersionPromise,
        available && notebook ? agent.readNotebookAgentSkills(notebook.path) : Promise.resolve([]),
        available && notebook ? agent.listInstalledNotebookTemplates(notebook.path) : Promise.resolve([]),
      ]);
      const current = getSelectedNotebookSnapshot();
      if (!active || generation !== requestGeneration || current?.id !== notebook?.id || current?.path !== notebook?.path || current?.missing !== notebook?.missing) return;
      frame.contentWindow?.postMessage({
        type: 'flowix:skill-market:context', language,
        appVersion: appVersion.status === 'fulfilled' ? appVersion.value : null,
        capabilities: { toast: true },
        notebookId: available ? notebook?.id ?? null : null,
        notebookAvailable: available, notebookName: notebook?.name ?? '',
        installedSkillIds: skills?.status === 'fulfilled' ? skills.value.map(item => item.id) : [],
        installedTemplateIds: templates?.status === 'fulfilled' ? templates.value : [],
      }, skillMarketOrigin);
    };
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== skillMarketOrigin || event.source !== frame.contentWindow || !isRecord(event.data)) return;
      if (event.data.type === 'flowix:skill-market:ready') { onReady(); void sendMarketContext(); return; }
      if (event.data.type === 'flowix:skill-market:toast') {
        const message = typeof event.data.message === 'string' ? event.data.message.trim() : '';
        if (!message || message.length > 1000) return;
        const tone = event.data.tone;
        toast.show(message, { tone: tone === 'success' || tone === 'error' || tone === 'warning' ? tone : 'info' });
        return;
      }
      void handleMarketInstall(event.data, {
        origin: skillMarketOrigin,
        isActive: () => active,
        getSelectedNotebook: getSelectedNotebookSnapshot,
        respond: message => frame.contentWindow?.postMessage(message, skillMarketOrigin),
        installSkill: agent.installCodexProjectSkillZip,
        installTemplate: agent.installNotebookTemplateZip,
        onInstalled: (kind, notebook) => {
          if (kind === 'skill') notifyNotebookSkillsChanged({ notebookId: notebook.id, notebookPath: notebook.path });
          else window.dispatchEvent(new Event(TEMPLATES_CHANGED));
        },
      });
    };
    const refresh = () => { void sendMarketContext(); };
    window.addEventListener('message', handleMessage);
    window.addEventListener(NOTEBOOK_SKILLS_CHANGED_EVENT, refresh);
    window.addEventListener(TEMPLATES_CHANGED, refresh);
    const unsubscribe = subscribeSelectedNotebook(refresh);
    void sendMarketContext();
    return () => {
      active = false;
      window.removeEventListener('message', handleMessage);
      window.removeEventListener(NOTEBOOK_SKILLS_CHANGED_EVENT, refresh);
      window.removeEventListener(TEMPLATES_CHANGED, refresh);
      unsubscribe();
    };
  }, [iframeRef, currentUrl, skillMarketOrigin, reloadToken, language, onReady]);
}

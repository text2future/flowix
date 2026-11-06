import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
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
  // Presentation updates must not reset the handshake for an existing document.
  const latest = useRef({ language, onReady });
  const refreshRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => { latest.current = { language, onReady }; }, [language, onReady]);
  useEffect(() => {
    const frame = iframeRef.current;
    if (!skillMarketOrigin || !frame) return;
    let ready = false;
    const sendTheme = () => {
      if (!ready) return;
      const target = frame.contentWindow;
      if (!target) return;
      const root = document.documentElement;
      const style = getComputedStyle(root);
      const colors: Record<string, string> = {};
      for (const token of ['background', 'document-bg', 'foreground', 'document-foreground', 'card', 'muted', 'muted-foreground', 'hover-bg', 'border', 'primary', 'primary-foreground', 'ring']) {
        const value = style.getPropertyValue(`--${token}`).trim();
        if (value) colors[token] = value;
      }
      target.postMessage({ type: 'flowix:skill-market:language', language: latest.current.language }, skillMarketOrigin);
      target.postMessage({
        type: 'flowix:skill-market:theme',
        colorScheme: style.colorScheme.includes('dark') ? 'dark' : 'light',
        colors,
      }, skillMarketOrigin);
    };
    let active = true;
    let generation = 0;
    let lastContext: Record<string, unknown> | null = null;
    const postContext = (context: Record<string, unknown>) => {
      lastContext = context;
      frame.contentWindow?.postMessage(context, skillMarketOrigin);
    };
    let contextNotebookKey: string | null = null;
    const appVersionPromise = Promise.resolve()
      .then(() => product.getInfo())
      .then(info => info.version)
      .catch(() => null);
    const sendMarketContext = async () => {
      if (!ready) return;
      const requestGeneration = ++generation;
      const notebook = getSelectedNotebookSnapshot();
      const available = Boolean(notebook?.path && !notebook.missing);
      // Connecting the market must not wait for filesystem scans or IPC.
      // Enrich the initial notebook context when those operations complete.
      const notebookKey = JSON.stringify([notebook?.id, notebook?.path, notebook?.missing]);
      if (contextNotebookKey !== notebookKey) {
        contextNotebookKey = notebookKey;
        postContext({
          type: 'flowix:skill-market:context', language: latest.current.language,
          appVersion: null, capabilities: { toast: true },
          notebookId: available ? notebook?.id ?? null : null,
          notebookAvailable: available, notebookName: notebook?.name ?? '',
          installedSkillIds: [], installedTemplateIds: [],
        });
      }
      const [appVersion, skills, templates] = await Promise.allSettled([
        appVersionPromise,
        available && notebook ? agent.readNotebookAgentSkills(notebook.path) : Promise.resolve([]),
        available && notebook ? agent.listInstalledNotebookTemplates(notebook.path) : Promise.resolve([]),
      ]);
      const current = getSelectedNotebookSnapshot();
      if (!active || generation !== requestGeneration || current?.id !== notebook?.id || current?.path !== notebook?.path || current?.missing !== notebook?.missing) return;
      postContext({
        type: 'flowix:skill-market:context', language: latest.current.language,
        appVersion: appVersion.status === 'fulfilled' ? appVersion.value : null,
        capabilities: { toast: true },
        notebookId: available ? notebook?.id ?? null : null,
        notebookAvailable: available, notebookName: notebook?.name ?? '',
        installedSkillIds: skills?.status === 'fulfilled' ? skills.value.map(item => item.id) : [],
        installedTemplateIds: templates?.status === 'fulfilled' ? templates.value : [],
      });
    };
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== skillMarketOrigin || event.source !== frame.contentWindow || !isRecord(event.data)) return;
      if (event.data.type === 'flowix:skill-market:ready') {
        if (ready) {
          sendTheme();
          if (lastContext) postContext({ ...lastContext, language: latest.current.language });
          return;
        }
        ready = true;
        sendTheme();
        latest.current.onReady();
        void sendMarketContext();
        return;
      }
      if (!ready) return;
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
    const refresh = () => { sendTheme(); void sendMarketContext(); };
    refreshRef.current = refresh;
    const observer = new MutationObserver(sendTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
    window.addEventListener('message', handleMessage);
    // A dev hot reload can recreate this bridge without reloading the market.
    // This public probe carries no notebook data; the response must still pass
    // the origin/source checks above before any context is sent.
    const probe = () => {
      if (!ready) frame.contentWindow?.postMessage({ type: 'flowix:skill-market:probe' }, '*');
    };
    frame.addEventListener('load', probe);
    probe();
    window.addEventListener(NOTEBOOK_SKILLS_CHANGED_EVENT, refresh);
    window.addEventListener(TEMPLATES_CHANGED, refresh);
    const unsubscribe = subscribeSelectedNotebook(refresh);
    void sendMarketContext();
    return () => {
      active = false;
      refreshRef.current = null;
      observer.disconnect();
      frame.removeEventListener('load', probe);
      window.removeEventListener('message', handleMessage);
      window.removeEventListener(NOTEBOOK_SKILLS_CHANGED_EVENT, refresh);
      window.removeEventListener(TEMPLATES_CHANGED, refresh);
      unsubscribe();
    };
  }, [iframeRef, currentUrl, skillMarketOrigin, reloadToken]);

  useEffect(() => { refreshRef.current?.(); }, [language]);
}

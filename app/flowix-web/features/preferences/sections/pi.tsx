'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Loader2, Plus, X } from 'lucide-react';
import { PencilSimpleIcon, TrashSimpleIcon } from '@phosphor-icons/react';
import {
  piModels,
  type PiModelCatalog,
  type PiModelEntryConfig,
  type PiProviderConfig,
} from '@platform/tauri/client';
import { Input } from '@shared/ui/input';
import { Button } from '@shared/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { Field, SectionHeader, FIELD_INPUT_CLASS } from '@features/preferences/sections/primitives';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';

type Draft = Omit<PiProviderConfig, 'credentialConfigured'>;
const CUSTOM_PROVIDER = '__pi_custom_provider__';
const FALLBACK_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'];
const API_LABELS: Record<string, string> = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'openai-codex-responses': 'OpenAI Codex Responses',
  'anthropic-messages': 'Anthropic Messages',
  'azure-openai-responses': 'Azure OpenAI Responses',
  'bedrock-converse-stream': 'Amazon Bedrock Converse',
  'google-generative-ai': 'Google Generative AI',
  'google-vertex': 'Google Vertex AI',
  'mistral-conversations': 'Mistral Conversations',
  'pi-messages': 'Pi Messages',
};
const PREFERENCES_SELECT_CONTENT_CLASS = 'flowix-preferences-select-content';
const PROVIDER_FORM_FIELD_CLASS = 'space-y-[3px]';
const PROVIDER_FORM_CONTROL_CLASS = `${FIELD_INPUT_CLASS} !bg-[color-mix(in_srgb,var(--muted)_50%,var(--card))]`;
const PROVIDER_FORM_SECRET_CLASS = `${FIELD_INPUT_CLASS} !border-[var(--primary)]`;
const EMPTY_DRAFT: Draft = {
  id: '', displayName: '', api: 'openai-completions', baseUrl: '', apiKey: '', defaultModelId: undefined, models: [],
};

function parseModels(value: string) {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [id, name = '', capabilities = ''] = line.split('|');
    const flags = capabilities.toLowerCase();
    return {
      id: id.trim(), name: name.trim(),
      reasoning: flags.includes('reasoning'), vision: flags.includes('vision'),
    };
  });
}

function serializeModels(models: PiModelEntryConfig[]): string {
  return models.map((model) => {
    const capabilities = [model.reasoning ? 'reasoning' : '', model.vision ? 'vision' : '']
      .filter(Boolean)
      .join(',');
    const name = model.name && model.name !== model.id ? model.name : '';
    return capabilities
      ? `${model.id} | ${name} | ${capabilities}`
      : name
        ? `${model.id} | ${name}`
        : model.id;
  }).join('\n');
}

function modelsFromDraft(value: string, existing: PiModelEntryConfig[]): PiModelEntryConfig[] {
  const existingById = new Map(existing.map((model) => [model.id, model]));
  return parseModels(value).map((model) => {
    const existingModel = existingById.get(model.id);
    return existingModel ? { ...existingModel, ...model } : model;
  });
}

export function PiSettingsSection() {
  const { t } = useI18n();
  const [providers, setProviders] = useState<PiProviderConfig[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [providerTemplateId, setProviderTemplateId] = useState(CUSTOM_PROVIDER);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [modelText, setModelText] = useState('');
  const [newModelId, setNewModelId] = useState('');
  const [modelListExpanded, setModelListExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerCatalog, setProviderCatalog] = useState<PiModelCatalog | null>(null);
  const [providerCatalogError, setProviderCatalogError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try { setProviders(await piModels.list()); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    let cancelled = false;
    void piModels.catalog()
      .then((catalog) => {
        if (!cancelled) {
          setProviderCatalog(catalog);
          setProviderCatalogError(null);
        }
      })
      .catch((value) => {
        if (!cancelled) setProviderCatalogError(value instanceof Error ? value.message : String(value));
      });
    return () => { cancelled = true; };
  }, []);

  const catalogProviders = useMemo(() => providerCatalog?.providers ?? [], [providerCatalog]);
  const compatibleProviders = catalogProviders;
  const selectedCatalogProvider = catalogProviders.find((provider) => provider.id === draft?.id);

  const beginEdit = (provider?: PiProviderConfig) => {
    setEditingId(provider?.id ?? null);
    setProviderTemplateId(provider && catalogProviders.some((entry) => entry.id === provider.id) ? provider.id : CUSTOM_PROVIDER);
    setDraft(provider ? { ...provider, apiKey: '' } : { ...EMPTY_DRAFT });
    setModelText(serializeModels(provider?.models ?? []));
    setNewModelId('');
    setModelListExpanded(false);
  };

  useEffect(() => {
    if (editingId === null || providerTemplateId !== CUSTOM_PROVIDER) return;
    if (catalogProviders.some((provider) => provider.id === editingId)) setProviderTemplateId(editingId);
  }, [catalogProviders, editingId, providerTemplateId]);

  const selectCatalogProvider = (providerId: string) => {
    setProviderTemplateId(providerId);
    if (!draft) return;
    if (providerId === CUSTOM_PROVIDER) {
      setDraft({ ...draft, id: '', apiKey: '' });
      return;
    }
    const provider = compatibleProviders.find((candidate) => candidate.id === providerId);
    if (!provider) return;
    const models = provider.models;
    setDraft({
      ...draft,
      id: provider.id,
      displayName: provider.displayName,
      api: provider.api,
      baseUrl: provider.baseUrl,
      apiKey: '',
      defaultModelId: models[0]?.id,
      models,
    });
    setModelText(serializeModels(models));
    setNewModelId('');
  };

  const selectApi = (api: string) => {
    if (!draft) return;
    setDraft({
      ...draft,
      api,
      models: draft.models.map((model) => ({ ...model, api: undefined })),
    });
  };

  const addModel = () => {
    const id = newModelId.trim();
    if (!id) return;
    const models = parseModels(modelText);
    if (models.some((model) => model.id === id)) {
      toast.error(t('preferences.pi.duplicateModel'));
      return;
    }
    setModelText(serializeModels([...models, { id, name: '', reasoning: false, vision: false }]));
    setNewModelId('');
  };

  const removeModel = (modelId: string) => {
    const models = parseModels(modelText).filter((model) => model.id !== modelId);
    setModelText(serializeModels(models));
    if (draft?.defaultModelId === modelId) setDraft({ ...draft, defaultModelId: undefined });
  };

  const save = async () => {
    if (!draft) return;
    const models = modelsFromDraft(modelText, draft.models);
    const providerIdBase = draft.id.trim() || draft.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider';
    let providerId = providerIdBase;
    let suffix = 2;
    while (providers.some((provider) => provider.id === providerId && provider.id !== editingId)) {
      providerId = `${providerIdBase}-${suffix++}`;
    }
    if (!draft.displayName.trim() || !draft.baseUrl.trim() || models.length === 0) {
      toast.error(t('preferences.pi.validation'));
      return;
    }
    setBusy(true);
    try {
      await piModels.save({ ...draft, id: providerId, models, credentialConfigured: false });
      if (editingId && editingId !== providerId) {
        try {
          await piModels.delete(editingId);
        } catch (value) {
          await reload();
          setDraft(null);
          setEditingId(null);
          toast.error(`${t('preferences.pi.oldProviderCleanupFailed')}: ${value instanceof Error ? value.message : String(value)}`);
          return;
        }
      }
      await reload();
      setDraft(null);
      setEditingId(null);
      toast.success(t('preferences.pi.saved'));
    } catch (value) {
      toast.error(value instanceof Error ? value.message : String(value));
    } finally { setBusy(false); }
  };

  const testConnection = async () => {
    if (!draft) return;
    const models = modelsFromDraft(modelText, draft.models);
    setTesting(true);
    try {
      const latency = await piModels.test({ ...draft, models, credentialConfigured: false });
      toast.success(`${t('preferences.pi.testSuccess')} (${latency} ms)`);
    } catch (value) {
      toast.error(value instanceof Error ? value.message : String(value));
    } finally { setTesting(false); }
  };

  const discoverModels = async () => {
    if (!draft) return;
    setDiscovering(true);
    try {
      const found = await piModels.discover({ ...draft, models: parseModels(modelText), credentialConfigured: false });
      const current = parseModels(modelText);
      const known = new Set(current.map((model) => model.id));
      const merged = [...current, ...found.filter((model) => !known.has(model.id)).map((model) => ({
        id: model.id, name: model.name, reasoning: model.reasoning, vision: model.vision,
      }))];
      setModelText(merged.map((model) => {
        const capabilities = [model.reasoning ? 'reasoning' : '', model.vision ? 'vision' : ''].filter(Boolean).join(',');
        return capabilities ? `${model.id} | ${model.name} | ${capabilities}` : model.name ? `${model.id} | ${model.name}` : model.id;
      }).join('\n'));
      toast.success(`${t('preferences.pi.discovered')} (${found.length})`);
    } catch (value) {
      toast.error(value instanceof Error ? value.message : String(value));
    } finally { setDiscovering(false); }
  };

  const remove = async (providerId: string) => {
    setBusy(true);
    try {
      await piModels.delete(providerId);
      await reload();
      toast.success(t('preferences.pi.deleted'));
    } catch (value) {
      toast.error(value instanceof Error ? value.message : String(value));
    } finally { setBusy(false); }
  };

  const setDefaultModel = async (provider: PiProviderConfig, modelId: string) => {
    setBusy(true);
    try {
      await piModels.save({ ...provider, apiKey: '', defaultModelId: modelId === '__none__' ? undefined : modelId });
      await reload();
    } catch (value) {
      toast.error(value instanceof Error ? value.message : String(value));
    } finally { setBusy(false); }
  };

  const cancelDraft = () => {
    setDraft(null);
    setEditingId(null);
    setModelListExpanded(false);
  };

  const renderProviderForm = (embedded = false) => {
    if (!draft) return null;
    return (
      <div className={embedded ? 'space-y-2 rounded-xl bg-[var(--card)] p-2.5' : 'space-y-2 rounded-lg border border-[var(--divider)] bg-[var(--card)] p-2.5'}>
        <div className="flex items-center justify-between"><h3 className="text-base font-semibold text-[var(--foreground)]">{t(editingId !== null ? 'preferences.pi.edit' : 'preferences.pi.add')}</h3><Button type="button" variant="ghost" className="h-7 px-2 text-sm" onClick={cancelDraft}>{t('preferences.pi.cancel')}</Button></div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field title={t('preferences.pi.providerCatalog')} className={PROVIDER_FORM_FIELD_CLASS}>
            <Select
              value={providerTemplateId}
              onValueChange={(value) => selectCatalogProvider(value)}
            >
              <SelectTrigger className="w-full !border-[var(--primary)]">
                <SelectValue>
                  {providerTemplateId === CUSTOM_PROVIDER
                    ? t('preferences.pi.customProvider')
                    : compatibleProviders.find((provider) => provider.id === providerTemplateId)?.displayName ?? providerTemplateId}
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="start" fitViewport maxHeight={240} className={PREFERENCES_SELECT_CONTENT_CLASS}>
                {compatibleProviders.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>{provider.displayName}</SelectItem>
                ))}
                <SelectItem value={CUSTOM_PROVIDER}>{t('preferences.pi.customProvider')}</SelectItem>
              </SelectContent>
            </Select>
            {providerCatalogError && (
              <p className="mt-1 text-xs text-[var(--muted-foreground)]" title={providerCatalogError}>
                {t('preferences.pi.catalogFallback')}
              </p>
            )}
          </Field>
          <Field title={t('preferences.pi.api')} className={PROVIDER_FORM_FIELD_CLASS}>
            <Select value={draft.api} onValueChange={selectApi}>
              <SelectTrigger className="w-full !bg-[color-mix(in_srgb,var(--muted)_50%,var(--card))]"><SelectValue /></SelectTrigger>
              <SelectContent align="start" fitViewport maxHeight={240} className={PREFERENCES_SELECT_CONTENT_CLASS}>
                {(providerCatalog?.apis.length ? providerCatalog.apis : FALLBACK_APIS).map((api) => (
                  <SelectItem key={api} value={api}>{API_LABELS[api] ?? api}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field title={t('preferences.pi.providerName')} className={PROVIDER_FORM_FIELD_CLASS}><Input className={PROVIDER_FORM_CONTROL_CLASS} value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field>
          <Field title={t('preferences.pi.defaultModel')} className={PROVIDER_FORM_FIELD_CLASS}>
            <Select value={draft.defaultModelId ?? '__none__'} onValueChange={(defaultModelId) => setDraft({ ...draft, defaultModelId: defaultModelId === '__none__' ? undefined : defaultModelId })}>
              <SelectTrigger className="w-full !bg-[color-mix(in_srgb,var(--muted)_50%,var(--card))]"><SelectValue>{draft.defaultModelId ? parseModels(modelText).find((model) => model.id === draft.defaultModelId)?.name || draft.defaultModelId : t('preferences.pi.noDefault')}</SelectValue></SelectTrigger>
              <SelectContent align="start" fitViewport maxHeight={240} className={PREFERENCES_SELECT_CONTENT_CLASS}>
                {parseModels(modelText).length === 0 && <SelectItem value="__none__">{t('preferences.pi.noDefault')}</SelectItem>}
                {parseModels(modelText).map((model) => <SelectItem key={model.id} value={model.id}>{model.name || model.id}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field title={t('preferences.pi.baseUrl')} className={PROVIDER_FORM_FIELD_CLASS}><Input className={`${PROVIDER_FORM_CONTROL_CLASS} w-full sm:w-3/5`} value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></Field>
        <Field
          title={t('preferences.pi.apiKey')}
          description={selectedCatalogProvider?.takesApiKey === false ? t('preferences.pi.apiKeyOptional') : undefined}
          className={PROVIDER_FORM_FIELD_CLASS}
        >
          <Input className={PROVIDER_FORM_SECRET_CLASS} type="password" autoComplete="new-password" value={draft.apiKey ?? ''} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder={t('preferences.pi.keyPlaceholder')} />
        </Field>
        <div>
            <Button type="button" variant="ghost" className="h-8 w-fit justify-start gap-1 rounded-none px-0 text-sm font-medium text-[var(--foreground)] hover:bg-transparent dark:hover:!bg-transparent aria-expanded:bg-transparent aria-expanded:text-[var(--foreground)]" aria-label={`${t(modelListExpanded ? 'preferences.pi.collapseModels' : 'preferences.pi.expandModels')} ${t('preferences.pi.modelIds')}`} aria-expanded={modelListExpanded} onClick={() => setModelListExpanded((expanded) => !expanded)}>
              <span>{t('preferences.pi.modelIds')}</span>
              <ChevronRight className={`size-4 transition-transform ${modelListExpanded ? 'rotate-90' : ''}`} />
            </Button>
            {modelListExpanded && (
              <div className="space-y-1 px-3">
                <div className="flex gap-2">
                  <Input className={FIELD_INPUT_CLASS} value={newModelId} onChange={(event) => setNewModelId(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addModel(); } }} placeholder={t('preferences.pi.newModelPlaceholder')} />
                  <Button type="button" size="sm" variant="outline" className="h-8 shrink-0 gap-0.5 rounded-lg" disabled={!newModelId.trim()} onClick={addModel}><Plus className="size-3.5" />{t('preferences.pi.addModel')}</Button>
                  <div className="flex shrink-0 items-center border-l border-[var(--divider)] pl-2">
                    <Button type="button" size="sm" variant="outline" className="h-8 rounded-lg" disabled={discovering || !draft.baseUrl.trim()} onClick={() => void discoverModels()}>{discovering && <Loader2 className="mr-2 size-3.5 animate-spin" />}{t('preferences.pi.discover')}</Button>
                  </div>
                </div>
                <div className="divide-y divide-[var(--divider)] px-1">
                  {parseModels(modelText).map((model) => (
                    <div key={model.id} className="flex min-w-0 items-center gap-2 py-1 first:pt-0 last:pb-0">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--foreground)]" title={model.name || model.id}>{model.name || model.id}</span>
                      {model.name && model.name !== model.id && <span className="min-w-0 flex-1 truncate text-right text-xs text-[var(--muted-foreground)]" title={model.id}>{model.id}</span>}
                      <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--destructive)]" aria-label={`${t('preferences.pi.removeModel')}: ${model.name || model.id}`} title={t('preferences.pi.removeModel')} onClick={() => removeModel(model.id)}>
                        <X className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                  {parseModels(modelText).length === 0 && (
                    <p className="py-2 text-xs text-[var(--muted-foreground)]">{t('preferences.pi.noModels')}</p>
                  )}
                </div>
              </div>
            )}
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-3"><Button type="button" variant="outline" className="h-8" onClick={cancelDraft}>{t('preferences.pi.cancel')}</Button><Button type="button" variant="outline" className="h-8" disabled={testing || modelText.trim().length === 0} onClick={() => void testConnection()}>{testing && <Loader2 className="mr-2 size-3.5 animate-spin" />}{t('preferences.pi.test')}</Button><Button type="button" className="ml-auto h-8" disabled={busy} onClick={() => void save()}>{busy && <Loader2 className="mr-2 size-3.5 animate-spin" />}{t('preferences.pi.save')}</Button></div>
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <SectionHeader title={t('preferences.pi.title')} description={t('preferences.pi.description')} />
      <div className="space-y-3">
        {loading && <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin" /></div>}
        {error && <p className="text-sm text-[var(--destructive)]">{error}</p>}
        {!loading && !error && providers.length === 0 && !draft && (
          <div className="rounded-lg border border-dashed border-[var(--divider)] px-4 py-8 text-center text-sm text-[var(--muted-foreground)]">
            {t('preferences.pi.empty')}
          </div>
        )}
        {providers.map((provider) => (
          <article key={provider.id} className={`rounded-xl border border-[var(--divider)] ${draft && editingId === provider.id ? '' : 'bg-[var(--card)] p-2.5'}`}>
            {draft && editingId === provider.id ? renderProviderForm(true) : (
              <>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-base font-semibold text-[var(--foreground)]" title={provider.displayName}>{provider.displayName}</span>
                  </div>
                  <div className="flex gap-1">
                    <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t('preferences.pi.edit')} title={t('preferences.pi.edit')} onClick={() => beginEdit(provider)} disabled={busy || Boolean(draft)}><PencilSimpleIcon className="h-4 w-4" aria-hidden="true" /></Button>
                    <Button type="button" variant="ghost" size="icon" className="size-7 hover:text-[var(--destructive)]" aria-label={t('preferences.pi.delete')} title={t('preferences.pi.delete')} disabled={busy || Boolean(draft)} onClick={() => void remove(provider.id)}><TrashSimpleIcon className="h-4 w-4" aria-hidden="true" /></Button>
                  </div>
                </div>
                <div className="flex items-center justify-start gap-2">
                  <span className="shrink-0 text-sm text-[var(--foreground)]">{t('preferences.pi.defaultModel')}</span>
                  <Select value={provider.defaultModelId ?? '__none__'} disabled={busy || Boolean(draft)} onValueChange={(modelId) => void setDefaultModel(provider, modelId)}>
                    <SelectTrigger className="w-[16rem]"><SelectValue>{provider.defaultModelId ? provider.models.find((model) => model.id === provider.defaultModelId)?.name || provider.defaultModelId : t('preferences.pi.noDefault')}</SelectValue></SelectTrigger>
                    <SelectContent align="start" fitViewport maxHeight={240} className={PREFERENCES_SELECT_CONTENT_CLASS}>
                      {provider.models.length === 0 && <SelectItem value="__none__">{t('preferences.pi.noDefault')}</SelectItem>}
                      {provider.models.map((model) => <SelectItem key={model.id} value={model.id}>{model.name || model.id}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
          </article>
        ))}
      </div>

      {draft && editingId === null && renderProviderForm()}
      <Button type="button" variant="outline" className="h-8 gap-0.5" style={{ marginTop: '10px' }} onClick={() => beginEdit()} disabled={busy || Boolean(draft)}><Plus className="size-3.5" />{t('preferences.pi.add')}</Button>
    </div>
  );
}

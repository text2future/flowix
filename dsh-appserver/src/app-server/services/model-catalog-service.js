import { CapabilityUnavailableError } from '../protocol/domain-errors.js'

export class ModelCatalogService {
  constructor(ctx, modelSettings, { loadBuiltinCatalog } = {}) {
    this.ctx = ctx
    this.modelSettings = modelSettings
    this.loadBuiltinCatalog = loadBuiltinCatalog || (() => null)
  }

  configured() {
    const configuration = this.modelSettings.describe()
    return Object.entries(configuration.providers).map(([provider, profile]) => ({
      provider,
      ...(typeof profile?.displayName === 'string' ? { displayName: profile.displayName } : {}),
      ...(typeof profile?.api === 'string' ? { api: profile.api } : {}),
      ...(typeof (profile?.baseURL ?? profile?.baseUrl) === 'string' ? { baseUrl: profile.baseURL ?? profile.baseUrl } : {}),
      takesApiKey: provider !== 'ollama',
      models: Array.isArray(profile?.models)
        ? profile.models.filter(model => model && typeof model.id === 'string')
        : typeof profile?.model === 'string' && profile.model ? [{ id: profile.model }] : [],
    }))
  }

  async catalog() {
    const configured = this.configured()
    try {
      const llm = this.ctx.get?.('llm') || this.ctx.llm
      if (!llm?.listConfigurableProviders || !llm?.listModels) return { providers: configured }
      const entries = await llm.listConfigurableProviders()
      const configuredRoutes = new Set(configured.map(provider => provider.provider))
      const configuredByRoute = new Map(configured.map(provider => [provider.provider, provider]))
      const builtinCatalog = await this.loadBuiltinCatalog()
      const builtins = new Map((builtinCatalog?.builtinProviders?.() ?? []).map(provider => [provider.id, provider]))
      const visible = builtinCatalog ? entries.filter(entry => builtins.has(entry.provider) || configuredRoutes.has(entry.provider)) : entries
      const providers = await Promise.all(visible.map(async entry => {
        const builtin = builtins.get(entry.provider)
        const builtinModels = builtinCatalog?.getBuiltinModels?.(entry.provider) ?? []
        const builtinModelsById = new Map(builtinModels.map(model => [model.id, model]))
        const configuredProvider = configuredByRoute.get(entry.provider)
        let models = []
        if (configuredRoutes.has(entry.provider)) {
          try { models = await llm.listModels(entry.provider) } catch { models = [] }
        }
        if (models.length === 0) {
          models = builtinModels
        } else if (builtinModels.length > 0) {
          // Active routes return their effective model list, but model metadata
          // such as `api` may be omitted there. Retain user additions and
          // overrides while filling those gaps from pi-ai's installed catalog.
          models = models.map(model => {
            const builtinModel = builtinModelsById.get(model.id)
            if (!builtinModel) return model
            return {
              ...builtinModel,
              ...model,
              api: model.api ?? builtinModel.api,
              baseUrl: model.baseUrl ?? builtinModel.baseUrl,
              contextWindow: model.contextWindow ?? builtinModel.contextWindow,
              maxTokens: model.maxTokens ?? builtinModel.maxTokens,
            }
          })
        }
        const first = models[0]
        const api = first?.api ?? configuredProvider?.api ?? builtinModels[0]?.api
        const baseUrl = configuredProvider?.baseUrl ?? first?.baseUrl ?? builtinModels[0]?.baseUrl
        return {
          provider: entry.provider,
          displayName: builtin?.name || entry.displayName || entry.provider,
          ...(baseUrl ? { baseUrl } : {}),
          ...(api ? { api } : {}),
          takesApiKey: builtin?.auth?.apiKey !== undefined || entry.provider !== 'ollama',
          models: models.map(model => ({
            id: model.id,
            ...(model.name ? { name: model.name } : {}),
            ...(model.api ? { api: model.api } : {}),
            ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
            ...(Number.isFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
            ...(Number.isFinite(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
          })),
        }
      }))
      const seen = new Set(providers.map(provider => provider.provider))
      return { providers: [...providers, ...configured.filter(provider => !seen.has(provider.provider))] }
    } catch {
      return { providers: configured }
    }
  }

  async discover(request = {}) {
    const llm = this.ctx.get?.('llm') || this.ctx.llm
    if (!llm?.discoverModels) throw new CapabilityUnavailableError('model-discovery')
    return { models: await llm.discoverModels('llm-pi-ai', request && typeof request === 'object' ? request : {}) }
  }
}

import { CapabilityUnavailableError } from '../protocol/domain-errors.js'

export class ThreadLifecycleService {
  constructor(ctx, registry, { createOptions, resumeOptions, applyPermission, projectThread }) {
    this.ctx = ctx
    this.registry = registry
    this.createOptions = createOptions
    this.resumeOptions = resumeOptions
    this.applyPermission = applyPermission
    this.projectThread = projectThread
  }

  live(id) { return this.registry.handle(id)?.agent || this.ctx.agents?.get?.(String(id)) }

  async start(id, config = {}) {
    const existing = this.live(id)
    if (existing) return this.projectThread(existing)
    const handle = await this.ctx.agents.create(this.createOptions(id, config))
    this.applyPermission(handle.agent, config.permissionMode)
    this.registry.setHandle(handle.agent.session.id, handle)
    return this.projectThread(handle.agent)
  }

  async resume(id, config = {}) {
    const key = String(id)
    const existing = this.live(key)
    if (existing) {
      // A live Agent keeps the model/provider options it was created with.
      // Returning it unconditionally makes `thread/resume` silently ignore a
      // model switch made between turns. Dispose only when the requested route
      // actually differs; the durable session remains available for resume.
      if (!runtimeRouteChanged(existing, config)) {
        this.applyPermission(existing, config.permissionMode)
        return this.projectThread(existing)
      }
      await this.registry.close(key)
    }
    const active = this.registry.resolutions.get(key)
    if (active) return this.projectThread(await active)
    const resolution = this.ctx.agents.resume(this.resumeOptions(key, config)).then(handle => {
      this.applyPermission(handle.agent, config.permissionMode)
      this.registry.setHandle(handle.agent.session.id, handle)
      return handle.agent
    })
    this.registry.resolutions.set(key, resolution)
    try { return this.projectThread(await resolution) } finally {
      if (this.registry.resolutions.get(key) === resolution) this.registry.resolutions.delete(key)
    }
  }

  close(id) { return this.registry.close(id).then(closed => ({ closed })) }

  async archive(id) {
    const controller = this.ctx.get?.('workspaceController') || this.ctx.workspaceController
    if (!controller?.archiveSession) throw new CapabilityUnavailableError('session-archive')
    const result = await controller.archiveSession({ sessionId: id })
    return { archived: Array.isArray(result?.archivedSessionIds) ? result.archivedSessionIds.map(String).includes(String(id)) : true }
  }
}

function runtimeRouteChanged(agent, config) {
  const requestedProvider = typeof config?.provider === 'string' ? config.provider.trim() : ''
  const requestedModel = typeof config?.model === 'string' ? config.model.trim() : ''
  if (!requestedProvider && !requestedModel) return false

  const events = Array.isArray(agent?.session?.events) ? agent.session.events : []
  const current = [...events]
    .reverse()
    .find(event => event?.type === 'request/context' && event?.data && typeof event.data === 'object')
    ?.data || agent?.session?.header?.config
  if (!current || typeof current !== 'object') return true
  if (requestedProvider && String(current.provider || '').trim() !== requestedProvider) return true
  if (requestedModel && String(current.model || '').trim() !== requestedModel) return true
  return false
}

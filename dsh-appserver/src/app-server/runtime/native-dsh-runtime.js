import { isPlanSteerPromptEvent } from '../projections/event-projector.js'
import { assistantChunkText, stableAssistantStreamItemId, stableItemId, stableTurnId, textOf, turnEndError, turnEndStatus } from '../projections/event-normalizer.js'
import { itemFromEvent, projectTurns, selectItemsView } from '../projections/turn-projector.js'
import { projectHistoryMessages } from '../projections/transcript-projector.js'
import { projectNotifications } from '../projections/notification-projector.js'

// Native adapter for Flowix's bundled DeepSeek Harness runtime.
// It deliberately imports no Flowix bridge package. The host supplies a Cordis ctx.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { AgentRuntimeRegistry } from './agent-runtime-registry.js'
import { CapabilityUnavailableError, InvalidInputError, RequestCancelledError, SessionNotFoundError } from '../protocol/domain-errors.js'
import { CredentialAdminService } from '../services/credential-admin-service.js'
import { RuntimeCapabilityService } from '../services/runtime-capability-service.js'
import { SessionRepository } from '../services/session-repository.js'
import { AttachmentGateway } from '../services/attachment-gateway.js'
import { ModelSettingsService } from '../services/model-settings-service.js'
import { CommandService } from '../services/command-service.js'
import { ModelCatalogService } from '../services/model-catalog-service.js'
import { TurnService } from '../services/turn-service.js'
import { ProjectionCache } from '../projections/projection-cache.js'
import { ThreadLifecycleService } from '../services/thread-lifecycle-service.js'
import { SessionQueryService } from '../services/session-query-service.js'
import { HistoryGuard } from './history-guard.js'
import { SessionProjectionIndex } from '../projections/session-projection-index.js'
import { ProjectionWorkerPool } from './projection-worker-pool.js'
import { ExportStore } from '../services/export-store.js'
import { GoalService, projectGoal } from '../services/goal-service.js'
import { SkillCatalogService } from '../services/skill-catalog-service.js'
import { ItemLifecycle } from '../services/item-lifecycle-service.js'
import { ConfigService, normalizeConfigChange } from '../services/config-service.js'
import { McpService, normalizeMcpStartupStatus } from '../services/mcp-service.js'

const require = createRequire(import.meta.url)

function serviceFrom(ctx, name) {
  return ctx?.[name] || ctx?.get?.(name)
}

function numericValue(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function disposeObservation(observation) {
  observation?.[Symbol.dispose]?.()
}

// Find the event range containing the requested number of complete turns.
// This scans boundaries backwards, then projects only the selected range;
// it does not materialize/project every historical turn on every page.
function historyTurnEventRange(events, beforeSequence, limit) {
  const end = Number.isInteger(Number(beforeSequence))
    ? Math.max(0, events.findIndex(event => Number(event.seq) >= Number(beforeSequence)))
    : events.length
  const endIndex = end === -1 ? events.length : end
  const starts = []
  for (let index = endIndex - 1; index >= 0; index--) {
    if (events[index].type === 'turn/start') {
      starts.push(index)
      if (starts.length > limit) break
    }
  }

  if (starts.length === 0) {
    // Legacy/session data without turn markers is one atomic history unit.
    return { events: events.slice(0, endIndex), oldestSequence: events[0]?.seq ?? null, hasMore: false }
  }

  const oldestTurnIndex = starts[Math.min(limit, starts.length) - 1]
  let oldestIndex = oldestTurnIndex

  // DSH command/run and command/done are durable operations, but deliberately
  // do not belong to a turn. A command can therefore precede the first
  // turn/start in a session (the common case for an initial /goal or /plan).
  // Keep that prefix with the first turn page so the command is not silently
  // lost from history. We only pull the prefix when this page reaches the
  // first turn; commands between later turns are naturally included with the
  // preceding turn page.
  const firstTurnIndex = starts[starts.length - 1]
  if (oldestTurnIndex === firstTurnIndex) {
    for (let index = firstTurnIndex - 1; index >= 0; index -= 1) {
      if (isStandaloneTimelineEvent(events[index])) {
        oldestIndex = index
        continue
      }
      if (index < firstTurnIndex && !events[index]?.type?.startsWith?.('turn/')) continue
      break
    }
  } else {
    // A compaction checkpoint can sit between two turns. Keep only the
    // contiguous standalone timeline suffix before this page's oldest turn;
    // the preceding turn remains on the older page.
    for (let index = oldestTurnIndex - 1; index >= 0; index -= 1) {
      if (!isStandaloneTimelineEvent(events[index])) break
      oldestIndex = index
    }
  }
  return {
    events: events.slice(oldestIndex, endIndex),
    oldestSequence: events[oldestIndex]?.seq ?? null,
    hasMore: starts.length > limit,
  }
}

// Commands and compaction checkpoints do not own a model turn, but they are
// durable timeline rows. Keep a checkpoint immediately before the oldest
// selected turn on that page; otherwise a long session can hide the compact
// marker until the user pages into older turns.
function isStandaloneTimelineEvent(event) {
  if (event?.type === 'command/run' || event?.type === 'command/done') return true
  if (event?.type !== 'user/message') return false
  const source = event.data?.source
  return source?.kind === 'plugin' && source?.plugin === 'compact'
}

/**
 * dsh-llm-pi-ai deliberately exposes the complete provider directory through
 * DSH's `llm` service, but `llm.listModels()` is only callable for an active
 * adapter route. Dormant built-in routes therefore need the same pi-ai model
 * catalog that dsh-llm-pi-ai uses internally. Resolve it from the managed
 * runtime executable rather than assuming that the profile copy has its own
 * node_modules tree (the profile intentionally contains only Flowix bundles).
 */
async function loadBuiltinPiAiCatalog() {
  const candidates = []
  let current = process.argv[1] ? dirname(process.argv[1]) : dirname(new URL(import.meta.url).pathname)
  for (let depth = 0; depth < 10; depth += 1) {
    candidates.push(join(current, 'node_modules/@earendil-works/pi-ai/dist/providers/all.js'))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  try {
    return await import('@earendil-works/pi-ai/providers/all')
  } catch (_) {
    for (const candidate of candidates) {
      try {
        if (existsSync(candidate)) return await import(pathToFileURL(candidate).href)
      } catch (_) {
        // Try the next managed-runtime location. Test/source environments do
        // not necessarily install the runtime's production dependencies.
      }
    }
  }
  return null
}

export class NativeDshAdapter {
  constructor(ctx, { history, projection, workers, exports: exportOptions } = {}) {
    this.ctx = ctx
    this.runtimeRegistry = new AgentRuntimeRegistry()
    this.projectionCache = new ProjectionCache(projection)
    this.projectionIndex = new SessionProjectionIndex(projection)
    this.projectionWorkers = new ProjectionWorkerPool(workers)
    this.exportStore = new ExportStore(exportOptions)
    this.goalService = new GoalService(this)
    this.historyGuard = new HistoryGuard(history)
    this.skillCatalog = new SkillCatalogService(ctx, { resolveAgent: id => this.resolveAgent(id) })
    this.configService = new ConfigService(ctx)
    this.mcpService = new McpService(ctx)
    this.skillCatalog.configService = this.configService
    this.credentialAdmin = new CredentialAdminService(ctx)
    this.runtimeCapabilities = new RuntimeCapabilityService(ctx, this.runtimeRegistry)
    this.sessionRepository = new SessionRepository(ctx, this.runtimeRegistry)
    this.attachmentGateway = new AttachmentGateway(ctx)
    this.modelSettings = new ModelSettingsService(ctx)
    this.modelCatalog = new ModelCatalogService(ctx, this.modelSettings, { loadBuiltinCatalog: loadBuiltinPiAiCatalog })
    this.commandService = new CommandService(ctx, {
      resolveAgent: id => this.resolveAgent(id),
      sessionRepository: this.sessionRepository,
      historyGuard: this.historyGuard,
      exportStore: this.exportStore,
      skillCatalog: this.skillCatalog,
    })
    this.turnService = new TurnService(ctx, {
      resolveAgent: id => this.resolveAgent(id), liveAgent: id => this.liveAgent(id),
      runtimeRegistry: this.runtimeRegistry, attachmentGateway: this.attachmentGateway, stableTurnId,
    })
    this.threadLifecycle = new ThreadLifecycleService(ctx, this.runtimeRegistry, {
      createOptions: (id, config) => this.agentCreateOptions(id, config),
      resumeOptions: (id, config) => this.agentResumeOptions(id, config),
      applyPermission: (agent, mode) => this.applyPermission(agent, mode),
      projectThread: agent => this.thread(agent),
    })
    this.sessionQueryService = new SessionQueryService(ctx, this.sessionRepository, {
      projectThread: (session, status = 'idle') => this.threadFromSession(session, true, status),
      startThread: id => this.startThread(id),
      historyGuard: this.historyGuard,
      projectionIndex: this.projectionIndex,
      projectionWorkers: this.projectionWorkers,
    })
    // Compatibility aliases keep the migration local while method groups are
    // progressively moved into dedicated application services.
    this.runtimes = this.runtimeRegistry.handles
    // Agent activation is process-local and owns the session's write handle.
    // Several App Server requests can arrive while a session is already being
    // resumed (for example a command plus a history/status refresh). Keep one
    // in-flight activation per provider session so those requests converge on
    // the same Agent instead of opening a second write handle.
    this.agentResolutions = this.runtimeRegistry.resolutions
    this.pendingTurns = this.runtimeRegistry.pendingTurns
    this.activeTurns = this.runtimeRegistry.activeTurns
    // DSH publishes assistant chunks on the process-local agent stream. The
    // durable session/event feed only contains the final assistant/message.
    // Keep the transient attempt identity until that durable settlement arrives
    // so streaming and the final snapshot target one assistant row.
    this.assistantStreams = this.runtimeRegistry.assistantStreams
    this.itemLifecycles = this.runtimeRegistry.itemLifecycles
    this.listeners = new Set()
    this.disposers = [
      ctx.on?.('session/event', (session, event) => {
        const threadId = String(session.id)
        this.projectionCache.invalidate(threadId)
        this.projectionIndex.ingest(threadId, event)
        this.projectEvent(threadId, event, session)
      }),
      ctx.on?.('agent/assistant-stream', payload => this.projectAssistantStream(payload)),
      ctx.on?.('agent/status', payload => { const threadId = String(payload.agent.session.id); this.emit({ jsonrpc: '2.0', method: 'thread/status/changed', params: { threadId, status: this.status(payload.status) } }) }),
      ctx.on?.('skills/changed', payload => {
        const revision = this.skillCatalog.invalidate()
        this.emit({ jsonrpc: '2.0', method: 'skills/changed', params: { revision, ...(payload && typeof payload === 'object' ? { change: payload } : {}) } })
      }),
      ctx.on?.('settings/changed', (...args) => {
        const payload = args.find(value => value && typeof value === 'object') || {}
        const change = normalizeConfigChange(payload)
        this.emit({ jsonrpc: '2.0', method: 'config/changed', params: change })
        if (change.namespace === 'flowix-appserver' && change.changedPaths?.some(path => path === 'skills' || path.startsWith('skills.'))) {
          const revision = this.skillCatalog.invalidate()
          this.emit({ jsonrpc: '2.0', method: 'skills/changed', params: { revision, change } })
        }
      }),
      ctx.on?.('mcpServer/startupStatus/updated', payload => {
        this.emit({ jsonrpc: '2.0', method: 'mcpServer/startupStatus/updated', params: normalizeMcpStartupStatus(payload) })
      }),
      ctx.on?.('mcpServer/oauthLogin/completed', payload => {
        this.emit({ jsonrpc: '2.0', method: 'mcpServer/oauthLogin/completed', params: payload && typeof payload === 'object' ? payload : {} })
      }),
      ctx.on?.('mcp/status/changed', payload => {
        this.emit({ jsonrpc: '2.0', method: 'mcpServer/status/changed', params: payload && typeof payload === 'object' ? payload : {} })
      })
    ].filter(Boolean)
    const mcpDisposer = this.mcpService.subscribe?.(payload => {
      if (payload?.method && payload?.params) {
        this.emit(payload)
        return
      }
      this.emit({ jsonrpc: '2.0', method: 'mcpServer/startupStatus/updated', params: normalizeMcpStartupStatus(payload) })
    })
    if (typeof mcpDisposer === 'function') this.disposers.push(mcpDisposer)
    // `session-log-download` is a Web bundle contribution and therefore is
    // not present in Flowix's native/stdio composition. Keep the same DSH
    // command name available in the native host; the response is enriched by
    // thread/command with the actual JSON export below.
    const commands = ctx.commands || ctx.get?.('commands')
    if (commands?.register) {
      try {
        const disposer = commands.register({
          name: 'export',
          description: 'Export this DSH session log',
          handler: invocation => invocation.rawInput.trim() === ''
            ? { kind: 'success', text: 'Session log export requested.' }
            : { kind: 'error', text: '/export does not accept arguments' },
        })
        if (typeof disposer === 'function') this.disposers.push(disposer)
      } catch (_) {
        // A profile may already provide the official export command. Keep its
        // registration and let thread/command enrich the response below.
      }
    }
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit(event) { for (const listener of this.listeners) listener(event) }
  assistantStreamState(threadId) {
    let state = this.assistantStreams.get(threadId)
    if (!state) {
      state = { byAttempt: new Map(), byStep: new Map(), bySequence: new Map() }
      this.assistantStreams.set(threadId, state)
    }
    return state
  }
  itemLifecycle(threadId) {
    let lifecycle = this.itemLifecycles.get(String(threadId))
    if (!lifecycle) {
      lifecycle = new ItemLifecycle(threadId)
      this.itemLifecycles.set(String(threadId), lifecycle)
    }
    return lifecycle
  }
  projectAssistantStream(payload) {
    const session = payload?.agent?.session
    const frame = payload?.frame
    if (!session || !frame || typeof frame !== 'object') return
    const threadId = String(session.id)
    const state = this.assistantStreamState(threadId)
    const attemptId = frame.attemptId == null ? undefined : String(frame.attemptId)
    const stepKey = frame.turn == null || frame.step == null ? undefined : `${frame.turn}:${frame.step}`
    if (frame.type === 'start') {
      if (!attemptId) return
      const itemId = stableAssistantStreamItemId(threadId, attemptId)
      const entry = { itemId, turn: frame.turn, step: frame.step }
      state.byAttempt.set(attemptId, entry)
      if (stepKey) state.byStep.set(stepKey, itemId)
      return
    }
    const entry = attemptId ? state.byAttempt.get(attemptId) : undefined
    if (frame.type === 'chunk') {
      const delta = assistantChunkText({ chunk: frame.chunk })
      if (delta === undefined) return
      const itemId = entry?.itemId || stableAssistantStreamItemId(threadId, attemptId || stepKey || 'current')
      const turnId = this.activeTurns.get(threadId) || (frame.turn == null ? undefined : stableTurnId(threadId, frame.turn))
      const transition = this.itemLifecycle(threadId).delta(itemId, {
        turnId, sourceSeq: frame.sequence ?? frame.revision, sourceSubsequence: frame.index, itemType: 'agentMessage',
      })
      if (transition.accepted && transition.started) this.emit({ jsonrpc: '2.0', method: 'item/started', params: { threadId, turnId, sourceSeq: frame.sequence ?? frame.revision, item: transition.item } })
      if (transition.accepted) this.emit({
        jsonrpc: '2.0', method: 'item/agentMessage/delta',
        params: {
          threadId, turnId, itemId, delta, revision: transition.item?.revision,
          ...(frame.sequence == null ? {} : { sourceSeq: frame.sequence }),
          ...(frame.index == null ? {} : { sourceSubsequence: frame.index }),
        },
      })
      return
    }
    if (frame.type === 'end') {
      const outcome = frame.outcome
      const sequence = outcome?.kind === 'committed' ? outcome.seq : undefined
      if (entry && sequence != null) state.bySequence.set(String(sequence), entry.itemId)
      // The assistant stream can finish just before DSH publishes the
      // durable assistant/message event. Keep the turn/step mapping alive
      // until that event arrives; older hosts do not include the committed
      // event sequence in the stream end frame, so deleting it here makes the
      // final snapshot look like a second assistant item to Flowix.
      //
      // The mapping is removed by assistantStreamItemIdForEvent once the
      // durable snapshot reconciles it, and the turn/end cleanup below covers
      // hosts that never publish a final snapshot.
      if (attemptId) state.byAttempt.delete(attemptId)
    }
  }
  assistantStreamItemIdForEvent(threadId, event) {
    if (event.type !== 'assistant/message') return undefined
    const state = this.assistantStreams.get(threadId)
    if (!state) return undefined
    const sequence = event.seq == null ? undefined : state.bySequence.get(String(event.seq))
    if (sequence) {
      state.bySequence.delete(String(event.seq))
      return sequence
    }
    const turn = event.data?.turn
    const step = event.data?.step
    if (turn == null || step == null) return undefined
    const key = `${turn}:${step}`
    const itemId = state.byStep.get(key)
    if (itemId) state.byStep.delete(key)
    return itemId
  }
  legacyAssistantStreamItemId(threadId, event) {
    if (event.type !== 'assistant/chunk') return undefined
    const turn = event.data?.turn
    const step = event.data?.step
    const stepKey = turn == null || step == null ? undefined : `${turn}:${step}`
    const state = this.assistantStreamState(threadId)
    if (stepKey && state.byStep.has(stepKey)) return state.byStep.get(stepKey)
    // Older DSH hosts expose assistant/chunk only. Chunks in one turn/step
    // are one logical assistant item; the event sequence is not an item id.
    const key = stepKey || this.activeTurns.get(threadId) || 'current'
    const itemId = stableAssistantStreamItemId(threadId, `legacy-${key}`)
    if (stepKey) state.byStep.set(stepKey, itemId)
    return itemId
  }
  projectEvent(threadId, event, session) {
    // Goal state is a durable DSH domain event, not a model item. Publish a
    // small provider notification so transports that keep a session-level
    // watcher (for example the desktop Goal Round monitor) can observe the
    // terminal lifecycle without polling or reopening the write handle.
    if (event.type === 'goal/change') {
      // The event is already the core-authoritative change. Do not rebuild
      // live notification state from the App Server's transient history cache.
      this.emit({
        jsonrpc: '2.0',
        method: 'goal/changed',
        params: { threadId, sourceSeq: event.seq, change: event.data },
      })
      const query = this.ctx?.get?.('sessionQuery') || this.ctx?.sessionQuery
      // In a native DSH host, the goal projection is the authoritative
      // snapshot. Re-read it after the committed event so a status-only
      // change (pause/complete/clear) cannot be projected from a one-event
      // approximation. Older hosts without sessionQuery keep the synchronous
      // event-fold compatibility path.
      if (typeof query?.observeSession === 'function') {
        void this.goalService.read(threadId).then(goal => {
          this.emit({
            jsonrpc: '2.0',
            method: goal ? 'thread/goal/updated' : 'thread/goal/cleared',
            params: {
              threadId,
              sourceSeq: event.seq,
              ...(goal ? { goal } : { goalId: event.data?.goal?.id || event.data?.goalId || undefined }),
              change: event.data,
            },
          })
        }).catch(() => {
          const goal = projectGoal(threadId, [event])
          this.emit({
            jsonrpc: '2.0',
            method: goal ? 'thread/goal/updated' : 'thread/goal/cleared',
            params: {
              threadId,
              sourceSeq: event.seq,
              ...(goal ? { goal } : { goalId: event.data?.goal?.id || event.data?.goalId || undefined }),
              change: event.data,
            },
          })
        })
      } else {
        const goal = projectGoal(threadId, [event])
        this.emit({
          jsonrpc: '2.0',
          method: goal ? 'thread/goal/updated' : 'thread/goal/cleared',
          params: {
            threadId,
            sourceSeq: event.seq,
            ...(goal ? { goal } : { goalId: event.data?.goal?.id || event.data?.goalId || undefined }),
            change: event.data,
          },
        })
      }
      return
    }
    // `/plan <prompt>` also persists a user/message for DSH's steer inbox.
    // The command/run row is the canonical product timeline item; suppress
    // this model-facing duplicate in live notifications just as history does.
    const events = session?.events || this.ctx.sessions?.get?.(threadId)?.events || [event]
    if (isPlanSteerPromptEvent(events, event)) return
    const turn = event.data?.turn
    if (event.type === 'turn/start') {
      const expected = this.pendingTurns.get(threadId)?.shift()
      const turnId = stableTurnId(threadId, turn ?? event.seq)
      if (expected && expected !== turnId) this.emit({ jsonrpc: '2.0', method: 'warning', params: { threadId, message: `Turn identity mismatch: expected ${expected}, received ${turnId}` } })
      this.activeTurns.set(threadId, turnId)
      this.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId, turnId, sourceSeq: event.seq, turn: { id: turnId, threadId, status: 'inProgress', items: [] } } })
      return
    }
    if (event.type === 'assistant/chunk') {
      const delta = assistantChunkText(event.data)
      if (delta !== undefined) {
        const turnId = this.activeTurns.get(threadId)
        const itemId = this.legacyAssistantStreamItemId(threadId, event)
        const transition = this.itemLifecycle(threadId).delta(itemId, {
          turnId, sourceSeq: event.seq, sourceSubsequence: event.data?.chunk?.index, event,
        })
        if (transition.accepted && transition.started) this.emit({ jsonrpc: '2.0', method: 'item/started', params: { threadId, turnId, sourceSeq: event.seq, item: transition.item } })
        if (transition.accepted) this.emit({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId, turnId, itemId, sourceSeq: event.seq, ...(event.data?.chunk?.index == null ? {} : { sourceSubsequence: event.data.chunk.index }), revision: transition.item?.revision, delta } })
      }
      return
    }
    const item = itemFromEvent(threadId, event)
    if (item) {
      const streamItemId = this.assistantStreamItemIdForEvent(threadId, event)
      if (streamItemId) item.id = streamItemId
      const turnId = this.activeTurns.get(threadId)
      const lifecycle = this.itemLifecycle(threadId)
      const terminal = ['user/message', 'assistant/message', 'tool/result', 'approval/decided'].includes(event.type)
      const transition = terminal
        ? lifecycle.complete(item, { turnId, sourceSeq: event.seq, event })
        : lifecycle.begin(item, { turnId, sourceSeq: event.seq, event })
      if (transition.accepted && transition.existing === undefined) this.emit({ jsonrpc: '2.0', method: 'item/started', params: { threadId, turnId, sourceSeq: event.seq, item: transition.item } })
      if (transition.accepted && terminal) this.emit({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, turnId, sourceSeq: event.seq, item: transition.item } })
    }
    if (event.type === 'turn/end') {
      const turnId = this.activeTurns.get(threadId) || stableTurnId(threadId, turn ?? event.seq)
      this.activeTurns.delete(threadId)
      if ((this.pendingTurns.get(threadId) || []).length === 0) this.pendingTurns.delete(threadId)
      // A turn is terminal. Any retained turn/step fallback mappings are no
      // longer useful after this point (they only exist to bridge a stream
      // end frame to the durable assistant/message snapshot).
      this.assistantStreams.delete(threadId)
      const failure = turnEndError(event.data)
      this.emit({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turnId, sourceSeq: event.seq, turn: { id: turnId, threadId, status: turnEndStatus(event.data), items: [], ...(failure ? { error: failure } : {}) } } })
    }
  }

  async startThread(id, config = {}) {
    return this.threadLifecycle.start(id, config)
  }

  async resumeThread(id, config = {}) {
    return this.threadLifecycle.resume(id, config)
  }

  async forkThread(sourceId, boundarySeq, childId) {
    const source = this.liveAgent(sourceId)?.session
      || this.ctx.sessions.get(sourceId)
      || (await this.resumeThread(sourceId), this.ctx.sessions.get(sourceId))
    if (!source) throw new SessionNotFoundError(sourceId)
    // A session returned by the registry can be a metadata/live view without
    // carrying its event array. Use the same durable snapshot as history/read
    // instead of assuming that `source.events` is always present.
    const snapshot = await this.eventSnapshot(sourceId)
    const events = Array.isArray(snapshot.events) ? snapshot.events : []
    const boundary = boundarySeq === undefined
      ? (Number.isInteger(Number(source.seq)) ? Number(source.seq) - 1 : (events.at(-1)?.seq ?? -1))
      : boundarySeq
    if (!Number.isInteger(Number(boundary)) || Number(boundary) < -1) throw new InvalidInputError('boundarySeq', `is invalid: ${boundary}`)
    const boundaryIndex = Number(boundary) === -1
      ? -1
      : events.findIndex(event => Number(event.seq) === Number(boundary))
    if (Number(boundary) !== -1 && boundaryIndex < 0) throw new InvalidInputError('boundarySeq', `does not exist: ${boundary}`)
    const boundaryEvent = boundaryIndex >= 0 ? events[boundaryIndex] : undefined
    if (boundaryEvent && ['turn/start', 'step/start', 'agent/inbox/spliced'].includes(boundaryEvent.type)) throw new InvalidInputError('boundarySeq', 'must identify a stable message boundary')
    // The UI exposes the final assistant/message as the fork point. In the
    // DSH event log its matching turn/end is normally the next event, so
    // cutting exactly at the message leaves the child with an open turn.
    // Finish that turn in the seed; otherwise the first follow-up can be
    // queued against a turn the runtime still considers active and produce no
    // notifications.
    let seedEnd = boundaryIndex >= 0 ? boundaryIndex : boundary
    if (boundaryEvent?.type === 'assistant/message') {
      const turnEndIndex = events.findIndex((event, index) => index > seedEnd && event.type === 'turn/end')
      if (turnEndIndex >= 0) seedEnd = turnEndIndex
    }
    const seed = events.slice(0, seedEnd + 1)
    const context = [...events].reverse().find(event => event.type === 'request/context')?.data || {}
    const header = snapshot.header || source.header || {}
    const agentPreset = header.agentPreset || process.env.DSH_AGENT_PRESET?.trim() || 'standard'
    const presets = this.ctx.get?.('agentPresets')
    const agentOptions = typeof context.provider === 'string' && context.provider && typeof context.model === 'string' && context.model
      ? { provider: context.provider, model: context.model }
      : undefined
    const id = childId || `session-${Date.now()}`
    const handle = await this.ctx.agents.create({
      sessionId: id,
      seed,
      meta: { parentSession: sourceId, cwd: header.cwd, agentPreset },
      ...(presets ? { setup: agentCtx => presets.mount(agentCtx, agentPreset) } : {}),
      ...(agentOptions ? { agentOptions } : {}),
    })
    this.runtimes.set(id, handle)
    return this.thread(handle.agent)
  }

  agentCreateOptions(id, config) {
    const agentPreset = this.agentPreset(config)
    const agentOptions = this.agentOptions(config)
    const presets = this.ctx.get?.('agentPresets')
    return {
      ...(typeof id === 'string' && id ? { sessionId: id } : {}),
      meta: {
        ...(typeof config.cwd === 'string' ? { cwd: config.cwd } : {}),
        ...(agentPreset ? { agentPreset } : {}),
        ...(typeof config.parentThreadId === 'string' ? { parentSession: config.parentThreadId } : {}),
        ...(typeof config.parentThreadId === 'string' ? { origin: 'subagent' } : {}),
        ...(Number.isSafeInteger(Number(config.delegationDepth)) && Number(config.delegationDepth) >= 0 ? { delegationDepth: Number(config.delegationDepth) } : {}),
      },
      ...(presets ? { setup: agentCtx => presets.mount(agentCtx, agentPreset) } : {}),
      ...(agentOptions ? { agentOptions } : {}),
    }
  }

  agentResumeOptions(id, config) {
    const agentPreset = this.agentPreset(config)
    const agentOptions = this.agentOptions(config)
    const presets = this.ctx.get?.('agentPresets')
    return {
      resumeSessionId: id,
      ...(presets ? { setup: agentCtx => presets.mount(agentCtx, agentPreset) } : {}),
      ...(agentOptions ? { agentOptions } : {}),
    }
  }

  agentPreset(config) { return typeof config.agentPreset === 'string' && config.agentPreset ? config.agentPreset : (process.env.DSH_AGENT_PRESET?.trim() || 'standard') }
  agentOptions(config) {
    if (typeof config.provider !== 'string' || !config.provider || typeof config.model !== 'string' || !config.model) return undefined
    return { provider: config.provider, model: config.model, ...(Number.isSafeInteger(config.maxTokens) && config.maxTokens > 0 ? { maxTokens: config.maxTokens } : {}) }
  }
  applyPermission(agent, permissionMode) {
    if (typeof permissionMode !== 'string' || !permissionMode) return
    const presets = this.ctx.get?.('permissionPresets')
    if (presets?.set) presets.set(agent.session, permissionMode)
  }

  async readThread(id, includeTurns = true) {
    if (includeTurns) return this.historyGuard.run(signal => this.readThreadSnapshot(id, true, signal))
    return this.readThreadSnapshot(id, false)
  }

  async readThreadSnapshot(id, includeTurns = true, signal) {
    const live = this.liveAgent(id)
    if (live) {
      if (includeTurns) this.historyGuard.checkEvents(live.session?.events || [], { sessionId: id })
      if (signal?.aborted) throw new RequestCancelledError()
      const result = this.thread(live, includeTurns)
      this.historyGuard.checkResult(result, { sessionId: id })
      return result
    }
    if (!includeTurns) {
      const metadata = await this.sessionRepository.metadata(id)
      return this.snapshotThread(id, { header: metadata.header || metadata, events: [] }, false)
    }
    // Keep thread/read on the same durable source as session/history. The
    // current DSH persistence service exposes event data through a read
    // handle; metadata-only inspection is only a legacy fallback.
    const snapshot = await this.eventSnapshot(id)
    this.historyGuard.checkEvents(snapshot.events || [], { sessionId: id })
    if (signal?.aborted) throw new RequestCancelledError()
    const result = this.snapshotThread(id, snapshot, includeTurns)
    this.historyGuard.checkResult(result, { sessionId: id })
    return result
  }

  async listThreads() {
    const live = (this.ctx.sessions.list?.() || []).map(session => this.threadFromSession(session, false))
    const persistence = this.ctx.get?.('sessionPersistence')
    if (!persistence?.list) return live
    const records = await persistence.list()
    const known = new Set(live.map(thread => thread.id))
    for (const record of records || []) {
      const header = record?.header || record
      const id = header?.id ?? record?.id
      if (id != null && !known.has(String(id))) {
        live.push({ id: String(id), parentThreadId: header?.parentSession ? String(header.parentSession) : undefined, status: 'idle', turns: [], ...(subagentMetadata(header) ? { subagent: subagentMetadata(header) } : {}) })
      }
    }
    return live
  }

  async listTurns(id, cursor = '0', limit = 50, snapshotSequence, itemsView = 'full') {
    const snapshot = await this.eventSnapshot(id)
    const ceiling = Number.isInteger(Number(snapshotSequence)) ? Number(snapshotSequence) : Number(snapshot.events?.at(-1)?.seq ?? 0)
    const events = (snapshot.events || []).filter(event => Number(event.seq) <= ceiling)
    this.historyGuard.checkEvents(events, { sessionId: id })
    this.projectionIndex.ensure(id, events)
    const turns = await this.projectionCache.getAsync(id, `turns:${ceiling}`, events, () => projectTurns(id, events, [], { preserveCompactedHistory: true, itemsView: 'full' }))
    const start = Math.max(0, Number.parseInt(cursor, 10) || 0)
    const data = selectItemsView(turns.slice(start, start + Math.min(200, Math.max(1, limit))), itemsView)
    return { data, snapshotSequence: ceiling, nextCursor: start + data.length < turns.length ? String(start + data.length) : null }
  }
  async listEvents(id, afterSeq = -1, limit = 200) {
    const page = await this.sessionRepository.eventsAfter(id, afterSeq, limit)
    return { data: page.events, nextCursor: page.nextCursor }
  }

  async readGoalEvents(id) {
    const snapshot = await this.eventSnapshot(id)
    return snapshot.events || []
  }

  async getGoal(id) { return this.goalService.get(id) }
  async setGoal(id, params) { return this.goalService.set(id, params) }
  async clearGoal(id, params) { return this.goalService.clear(id, params) }

  async eventSnapshot(id) {
    return this.sessionRepository.snapshot(id)
  }

  async replayNotifications(id, afterSeq = -1, limit = 200) {
    const eventLimit = Math.min(1000, Math.max(1, Number(limit) || 200))
    const page = await this.sessionRepository.eventsAfter(id, afterSeq, eventLimit)
    const notifications = projectNotifications(id, page.events)
      .filter(event => Number(event.params?.sourceSeq) > Number(afterSeq))
    return {
      data: notifications,
      nextCursor: page.nextCursor,
      snapshotSequence: page.snapshotSequence ?? Number(page.events.at(-1)?.seq ?? afterSeq),
    }
  }

  async startTurn(id, input) {
    return this.turnService.start(id, input)
  }

  async steerTurn(id, input, clientMessageId) {
    return this.turnService.steer(id, input, clientMessageId)
  }

  async interruptTurn(id) {
    return this.turnService.interrupt(id)
  }

  activeTurnId(id) { return this.turnService.activeId(id) }

  async findToolCall(id, callId) {
    if (!callId) return undefined
    const snapshot = await this.eventSnapshot(id)
    return [...(snapshot.events || [])].reverse().find(event => event.type === 'tool/call' && String(event.data?.callId) === String(callId))
  }

  async readApprovalPolicy(id) {
    const snapshot = await this.eventSnapshot(id)
    const event = [...(snapshot.events || [])].reverse().find(item => item.type === 'approval/policy')
    const fallback = this.ctx.get?.('approval')?.config?.policy || 'ask'
    return { threadId: id, policy: event?.data?.policy || fallback, source: event ? 'session' : 'default', supportedPolicies: ['ask', 'never'] }
  }

  async writeApprovalPolicy(id, policy) {
    if (!['ask', 'never'].includes(policy)) throw new InvalidInputError('policy', 'must be "ask" or "never"')
    const agent = await this.resolveAgent(id)
    const approval = this.ctx.get?.('approval')
    if (!approval?.setPolicy) throw new CapabilityUnavailableError('approval-policy')
    approval.setPolicy(agent, policy)
    return this.readApprovalPolicy(id)
  }

  async closeThread(id) {
    const result = await this.threadLifecycle.close(id)
    this.projectionCache.invalidate(id)
    this.projectionIndex.delete(id)
    return result
  }

  async archiveThread(id) {
    return this.threadLifecycle.archive(id)
  }

  async executeCommand(id, line, submittedAttachments = []) {
    return this.commandService.execute(id, line, submittedAttachments)
  }

  readExport(receiptId) { return this.exportStore.read(receiptId) }

  /**
   * Describe DSH-owned work that may outlive command/done. The desktop
   * transport consumes this effect instead of maintaining a second parser for
   * command names and guessing with a timeout whether a turn will appear.
   */
  commandEffects(line, attachments, execution) {
    return this.commandService.effects(line, attachments, execution)
  }

  async listSkills(id) {
    return this.commandService.listSkills(id)
  }

  async listSkillCatalog(params = {}) {
    return this.skillCatalog.list(params)
  }

  readConfig(namespace) { return this.configService.read(namespace) }
  writeConfigValue(params) { return this.configService.writeValue(params) }
  batchWriteConfig(params) { return this.configService.batchWrite(params) }
  readConfigRequirements(namespace) { return this.configService.requirements(namespace) }
  listMcpServerStatus(params) { return this.mcpService.list(params) }
  refreshMcpServers() { return this.mcpService.refresh() }
  reloadMcpConfig() { return this.mcpService.reloadConfig() }
  loginMcpServer(params) { return this.mcpService.oauthLogin(params) }
  callMcpTool(params) { return this.mcpService.callTool(params) }
  readMcpResource(params) { return this.mcpService.readResource(params) }
  spawnSubagent(parentThreadId, request) { return this.subagentService?.spawn(parentThreadId, request) }
  listSubagents(parentThreadId) { return this.subagentService?.list(parentThreadId) }
  sendSubagent(childThreadId, request) { return this.subagentService?.send(childThreadId, request) }
  resumeSubagent(childThreadId) { return this.subagentService?.resume(childThreadId) }
  interruptSubagent(childThreadId) { return this.subagentService?.interrupt(childThreadId) }
  closeSubagent(childThreadId) { return this.subagentService?.close(childThreadId) }

  async flush(id) {
    let session = this.runtimes.get(id)?.agent?.session
    if (!session) {
      try { session = this.ctx.agents.get(id)?.session } catch { /* an agent-owned scope may already be inactive */ }
    }
    if (!session) {
      try { session = this.ctx.sessions.get(id) } catch { /* an agent-owned session scope may already be inactive */ }
    }
    if (session) {
      try { return { flushed: await this.ctx.sessions.flush(session) } } catch { /* fall back to committed persistence below */ }
    }
    const persistence = serviceFrom(this.ctx, 'sessionPersistence')
    const snapshot = typeof persistence?.stat === 'function'
      ? await persistence.stat(id)
      : await persistence?.inspect?.(id)
    if (!snapshot) throw new SessionNotFoundError(id)
    return { flushed: true }
  }

  async ensureSession(id) {
    const live = this.ctx.agents.get(id)
    if (live) return this.thread(live)
    const persistence = serviceFrom(this.ctx, 'sessionPersistence')
    if (typeof persistence?.stat === 'function') {
      const metadata = await persistence.stat(id)
      if (metadata) {
        const snapshot = await this.eventSnapshot(id)
        return this.snapshotThread(id, snapshot, true)
      }
    } else if (persistence?.inspect) {
      const snapshot = await persistence.inspect(id)
      if (snapshot) return this.snapshotThread(id, snapshot, true)
    }
    return this.startThread(id)
  }

  async sessionHistory(id, { beforeSequence, snapshotSequence, limit = 50 } = {}) {
    const snapshot = await this.eventSnapshot(id)
    const all = snapshot.events || []
    const ceiling = Number.isInteger(Number(snapshotSequence)) ? Number(snapshotSequence) : Number(all.at(-1)?.seq ?? 0)
    const before = Number.isInteger(Number(beforeSequence)) ? Number(beforeSequence) : Number.POSITIVE_INFINITY
    const toolNames = new Map()
    for (const event of all) {
      if (event.type !== 'tool/call') continue
      const callId = event.data?.callId || event.data?.id
      const name = event.data?.name || event.data?.toolName
      if (callId && name) toolNames.set(String(callId), String(name))
    }
    const pageLimit = Math.min(200, Math.max(1, Number(limit) || 50))
    // `limit` is deliberately a turn count, rather than a message count. A
    // turn may contain a user message, multiple tool calls/results, reasoning,
    // and an assistant message; slicing projected messages would split that
    // atomic conversation unit across pages.
    const visibleEvents = all.filter(event => Number(event.seq) <= ceiling)
    const page = historyTurnEventRange(visibleEvents, before, pageLimit)
    // Project the selected page against the complete event-log surface. A
    // replacement checkpoint can shadow events that precede this page, so
    // giving the projector only page.events would resurrect compacted rows.
    // Keep aggregation/surface projection bounded by the requested snapshot
    // ceiling. A historical snapshot must not see a future command/done or a
    // future compaction checkpoint while paging older rows.
    const messages = projectHistoryMessages(id, page.events, toolNames, visibleEvents, {
      // The DSH model context still follows its native surface replacement,
      // while Flowix renders a durable append-only conversation timeline.
      preserveCompactedHistory: true,
    })
    return {
      sessionId: id,
      messages,
      oldestSequence: page.oldestSequence == null ? null : Number(page.oldestSequence),
      snapshotSequence: ceiling,
      hasMore: page.hasMore,
    }
  }

  async listJobs(id) {
    const agent = this.ctx.agents?.get?.(id)
    const jobs = this.ctx.get?.('jobs')
    if (!jobs?.list) return { jobs: [] }
    return { jobs: jobs.list(agent).map(job => ({
      id: String(job.id), kind: String(job.kind || 'job'), label: String(job.label || job.id),
      status: job.status, ...(job.detail === undefined ? {} : { detail: job.detail }),
      startedAt: job.startedAt, ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    })) }
  }

  async sessionUsage(id) {
    const query = serviceFrom(this.ctx, 'sessionQuery')
    let observation
    let snapshot
    let projections
    if (typeof query?.observeSession === 'function') {
      observation = await query.observeSession(id, { projectionMode: 'all' })
      snapshot = { header: observation.header, events: observation.events }
      projections = observation.projections?.values || {}
    } else {
      snapshot = await this.eventSnapshot(id)
    }
    projections ||= {}
    const events = snapshot?.events || []
    try {
      const legacyUsage = events.filter(event => event.type === 'assistant/message' && event.data?.usage).reduce((total, event) => {
        const data = event.data.usage
        total.inputTokens += Number(data.inputTokens || data.input_tokens || 0)
        total.outputTokens += Number(data.outputTokens || data.output_tokens || 0)
        total.cacheReadTokens += Number(data.cacheReadTokens || data.cache_read_tokens || 0)
        total.cacheWriteTokens += Number(data.cacheWriteTokens || data.cache_write_tokens || 0)
        return total
      }, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
      const context = [...events].reverse().find(event => event.type === 'request/context')?.data || {}
      const tokenTotals = projections.tokenUsage?.totals || projections.tokenUsage || {}
      const contextPressure = projections.contextPressure || {}
      return {
        sessionId: id,
        // DSH 1.6.x exposes canonical cumulative values through the
        // tokenUsage projection. Fall back to the legacy event fold for older
        // runtimes or profiles without the token-meter plugin.
        inputTokens: numericValue(tokenTotals.uncachedInputTokens, legacyUsage.inputTokens),
        outputTokens: numericValue(tokenTotals.outputTokens, legacyUsage.outputTokens),
        cacheReadTokens: numericValue(tokenTotals.cacheReadTokens, legacyUsage.cacheReadTokens),
        cacheWriteTokens: numericValue(tokenTotals.cacheWriteTokens, legacyUsage.cacheWriteTokens),
        // projectedTokens is the occupancy for the next request, including
        // surface movement after the latest provider usage sample.
        contextTokens: contextPressure.projectedTokens ?? context.contextTokens ?? null,
        contextWindow: contextPressure.contextWindow ?? context.contextWindow ?? null,
        modelId: context.model ?? context.modelId ?? null,
      }
    } finally {
      disposeObservation(observation)
    }
  }

  listPlugins() {
    // Loader entries are the actual configured plugin rows. The inventory is
    // the public projection when that optional bundle is mounted. `ctx.registry`
    // is only a Cordis runtime registry: its values are runtime records, not
    // plugin manifests, so it cannot reliably provide an id/name.
    const loader = this.ctx.get?.('loader') || this.ctx.loader
    const loaderEntries = loader?.entries ? Array.from(loader.entries())
      .filter(entry => !entry.options?.group)
      .map(entry => ({
        id: entry.options?.id,
        entryId: entry.options?.id,
        moduleName: entry.options?.name,
        enabled: !entry.disabled,
      })) : []
    const profile = profilePlugins()
    const profileNames = new Set(profile.map(plugin => plugin.id))
    const hostEntries = loaderEntries.filter(entry => !profileNames.has(entry.moduleName) && !profileNames.has(entry.id))
    const inventory = this.ctx.get?.('pluginInventory')
    const inventoryEntries = inventory?.list?.()?.entries
    const registry = this.ctx.get?.('plugins') || this.ctx.get?.('pluginRegistry') || this.ctx.registry
    const entries = hostEntries.length > 0
      ? hostEntries
      : Array.isArray(inventoryEntries)
      ? inventoryEntries
      : registry?.list?.() || registry?.plugins || (registry?.values ? Array.from(registry.values()) : [])
    const plugins = Array.from(entries, (plugin, index) => {
      const inventoryEntry = typeof plugin === 'object' && plugin !== null && 'moduleName' in plugin
      const inventoryId = inventoryEntry ? plugin.moduleName : undefined
      const id = typeof plugin === 'string'
        ? plugin
        : String(plugin.id || inventoryId || plugin.name || plugin.pluginId || plugin.callback?.name || 'unknown')
      const name = typeof plugin === 'string'
        ? plugin
        : String(plugin.name || inventoryId || plugin.id || plugin.pluginId || plugin.callback?.name || 'unknown')
      const keyId = typeof plugin === 'object' && plugin !== null
        ? String(plugin.entryId || id)
        : id
      return {
        key: `host:${index}:${keyId}`,
        id,
        name,
        enabled: typeof plugin === 'string' || plugin.enabled !== false,
        toggleable: false,
        scope: 'host',
      }
    })
    const presets = presetPlugins()
    return {
      plugins: {
        platform: process.platform,
        host: plugins,
        presets,
        profile,
      },
    }
  }

  profileInfo() {
    return this.runtimeCapabilities.profile()
  }

  statusReport() {
    return { ...this.runtimeCapabilities.status(), history: this.historyGuard.snapshot(), projectionCache: this.projectionCache.snapshot(), projectionWorkers: this.projectionWorkers.snapshot() }
  }

  capabilitiesReport() {
    return this.runtimeCapabilities.report()
  }

  capabilityNames() {
    return this.runtimeCapabilities.names()
  }

  protocolCapabilities() {
    return this.runtimeCapabilities.protocol()
  }

  describeCredentials(reference) {
    return this.credentialAdmin.describe(reference)
  }

  async setCredential(reference, value) {
    return this.credentialAdmin.set(reference, value)
  }

  async unsetCredential(reference) {
    return this.credentialAdmin.unset(reference)
  }

  validateCredentialReference(reference) {
    return this.credentialAdmin.validateReference(reference)
  }

  describeModels() {
    return this.modelSettings.describe()
  }

  /** Return configured routes in the provider-array shape used by clients. */
  async catalogModels() {
    const configuration = this.describeModels()
    const configured = Object.entries(configuration.providers).map(([provider, profile]) => ({
        provider,
        ...(typeof profile?.displayName === 'string' ? { displayName: profile.displayName } : {}),
        ...(typeof (profile?.baseURL ?? profile?.baseUrl) === 'string'
          ? { baseUrl: profile.baseURL ?? profile.baseUrl }
          : {}),
        takesApiKey: provider !== 'ollama',
        models: Array.isArray(profile?.models)
          ? profile.models.filter(model => model && typeof model.id === 'string')
          : typeof profile?.model === 'string' && profile.model
            ? [{ id: profile.model }]
            : [],
      }))

    // Read the provider directory through DSH's public llm service. This is
    // the registry assembled by llm-pi-ai (built-ins plus configured routes),
    // so the app-server does not need to import a package from a particular
    // bundle/profile path. Keep configured routes as an overlay as a safety
    // net: custom routes must remain visible even on older runtimes.
    try {
      const llm = this.ctx.get?.('llm')
      if (!llm?.listConfigurableProviders || !llm?.listModels) throw new CapabilityUnavailableError('model-catalog')
      const entries = await llm.listConfigurableProviders()
      const configuredRoutes = new Set(configured.map(provider => provider.provider))
      const builtinCatalog = await loadBuiltinPiAiCatalog()
      const builtinProviders = new Map(
        (builtinCatalog?.builtinProviders?.() ?? []).map(provider => [provider.id, provider]),
      )
      // The configurable-provider directory is shared by DSH plugins. Keep
      // this endpoint scoped to llm-pi-ai's installed provider catalog, while
      // retaining any already-configured non-pi-ai route as an overlay below.
      // This prevents dsh-llm-deepseek's `deepseek-official` route from being
      // presented as an llm-pi-ai provider with an empty model list.
      const catalogEntries = builtinCatalog
        ? entries.filter(entry => builtinProviders.has(entry.provider) || configuredRoutes.has(entry.provider))
        : entries
      const providers = await Promise.all(catalogEntries.map(async entry => {
        const builtin = builtinProviders.get(entry.provider)
        let models = []
        // An active route is authoritative: it includes a user's configured
        // model directory and custom route metadata. Dormant built-ins have no
        // adapter registration, so asking llm.listModels() for them throws.
        if (configuredRoutes.has(entry.provider)) {
          try { models = await llm.listModels(entry.provider) } catch (_) { models = [] }
        }
        if (models.length === 0 && builtinCatalog?.getBuiltinModels) {
          models = builtinCatalog.getBuiltinModels(entry.provider) ?? []
        }
        const firstModel = models[0]
        const takesApiKey = builtin?.auth?.apiKey !== undefined
          ? true
          : entry.provider === 'ollama'
            ? false
            : true
        return {
          provider: entry.provider,
          // dsh-llm-pi-ai currently uses the route id as the directory's
          // displayName for built-ins. Prefer pi-ai's human-readable provider
          // name while preserving the explicit name of custom routes.
          displayName: builtin?.name || entry.displayName || entry.provider,
          ...(firstModel?.baseUrl ? { baseUrl: firstModel.baseUrl } : {}),
          ...(firstModel?.api ? { api: firstModel.api } : {}),
          // The public configurable-provider directory intentionally omits
          // credential details. Keep a conservative default; keyless
          // providers can still be used by leaving the field empty and the
          // runtime will perform the definitive validation.
          takesApiKey,
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
    } catch (_) {
      // Older/test runtimes may not expose pi-ai as a package. Configured
      // routes still provide the exact legacy behavior in that case.
      return { providers: configured }
    }
  }

  async discoverModels(request = {}) {
    const llm = this.ctx.get?.('llm')
    if (!llm?.discoverModels) throw new CapabilityUnavailableError('model-discovery')
    return { models: await llm.discoverModels('llm-pi-ai', request && typeof request === 'object' ? request : {}) }
  }

  async configureModel(route, profile, expectedRevision) {
    return this.modelSettings.upsert(route, profile, expectedRevision)
  }

  async deleteModel(route, expectedRevision) {
    return this.modelSettings.remove(route, expectedRevision)
  }

  validateRoute(route) {
    return this.modelSettings.validateRoute(route)
  }

  validateRevision(revision) {
    return this.modelSettings.validateRevision(revision)
  }

  liveAgent(id) {
    const key = String(id)
    return this.runtimes.get(key)?.agent || this.ctx.agents?.get?.(key)
  }

  async resolveAgent(id) {
    const key = String(id)
    const existing = this.liveAgent(key)
    if (existing) return existing

    const active = this.agentResolutions.get(key)
    if (active) return active

    const resolution = (async () => {
      const current = this.liveAgent(key)
      if (current) return current
      try {
        const resumed = await this.ctx.agents.resume(this.agentResumeOptions(key, {}))
        this.applyPermission(resumed.agent, undefined)
        this.runtimes.set(String(resumed.agent.session.id), resumed)
        return resumed.agent
      } catch (error) {
        if (!this.isMissingSessionError(error)) throw error
        const currentAfterResume = this.liveAgent(key)
        if (currentAfterResume) return currentAfterResume
        const started = await this.ctx.agents.create(this.agentCreateOptions(key, {}))
        this.runtimes.set(String(started.agent.session.id), started)
        return started.agent
      }
    })()
    this.agentResolutions.set(key, resolution)
    try {
      return await resolution
    } finally {
      if (this.agentResolutions.get(key) === resolution) this.agentResolutions.delete(key)
    }
  }

  isMissingSessionError(error) {
    const code = String(error?.code || error?.name || '').toLowerCase()
    const message = String(error?.message || error || '').toLowerCase()
    return /not[_ -]?found|missing|unknown[_ -]?session|session.*does not exist|no session/.test(`${code} ${message}`)
  }

  thread(agent, includeTurns = true) { return this.threadFromSession(agent.session, includeTurns, agent.status) }
  // `thread/read` is the app-server transcript snapshot, not DSH's private
  // model context. Preserve compacted rows here so it has the same history
  // semantics as `session/history` and Codex's thread transcript APIs.
  threadFromSession(session, includeTurns = true, status = 'idle') {
    const id = String(session.id)
    const messages = includeTurns ? session.deriveMessages?.() || [] : []
    const events = session.events || []
    const turns = includeTurns ? this.projectionCache.get(id, 'turns', events, () => projectTurns(id, events, messages, { preserveCompactedHistory: true })) : []
    return { id, parentThreadId: session.header?.parentSession ? String(session.header.parentSession) : undefined, status: this.status(status), turns, ...(subagentMetadata(session.header) ? { subagent: subagentMetadata(session.header) } : {}) }
  }
  snapshotThread(id, snapshot, includeTurns) { const events = snapshot.events || []; return { id, parentThreadId: snapshot.header?.parentSession ? String(snapshot.header.parentSession) : undefined, status: 'idle', turns: includeTurns ? projectTurns(id, events, [], { preserveCompactedHistory: true }) : [], ...(subagentMetadata(snapshot.header) ? { subagent: subagentMetadata(snapshot.header) } : {}) } }
  status(status) { return typeof status === 'string' && status.includes('run') ? 'running' : status === 'closed' ? 'closed' : 'idle' }
  textOf(value) { return textOf(value) }
  textFromInput(input) { if (typeof input === 'string') return input; if (Array.isArray(input)) { const text = input.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n'); return text || JSON.stringify(input) } return typeof input?.text === 'string' ? input.text : JSON.stringify(input) }
  async admitTurnContent(input) {
    const text = this.textFromInput(input)
    return this.attachmentGateway.admitTurnInput(input, text)
  }
  async dispose() {
    for (const dispose of this.disposers) dispose?.()
    this.listeners.clear()
    this.projectionCache.clear()
    this.projectionIndex.clear()
    await this.projectionWorkers.dispose()
    await this.exportStore.dispose()
    await this.runtimeRegistry.dispose()
  }
}

function subagentMetadata(header) {
  return header?.origin === 'subagent' ? { origin: 'subagent' } : undefined
}

function profilePlugins() {
  const profileDir = process.env.DSH_PROFILE_DIR
  if (!profileDir) return []
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const bundles = Array.isArray(manifest.dsh?.profile?.bundles)
      ? manifest.dsh.profile.bundles.filter(value => typeof value === 'string')
      : []
    return bundles.map((packageName, index) => {
      let name = packageName
      try {
        const packageManifest = JSON.parse(readFileSync(join(profileDir, 'node_modules', packageName, 'package.json'), 'utf8'))
        name = packageManifest.description?.trim() || packageManifest.name?.trim() || packageName
      } catch (_) {}
      return {
        key: `profile:${index}:${packageName}`,
        id: packageName,
        name,
        enabled: true,
        toggleable: false,
        removable: false,
        scope: 'profile',
      }
    })
  } catch (_) {
    return []
  }
}

function disabledPluginKeys() {
  const path = process.env.FLOWIX_DSH_PLUGIN_SETTINGS_PATH
  if (!path) return new Set()
  try {
    const settings = JSON.parse(readFileSync(path, 'utf8'))
    return new Set(Array.isArray(settings?.disabled) ? settings.disabled.filter(value => typeof value === 'string') : [])
  } catch (_) {
    return new Set()
  }
}

function presetPlugins() {
  const root = presetRoot()
  if (!root) return {}
  const disabled = disabledPluginKeys()
  const result = {}
  for (const preset of ['standard', 'code', 'minimal', 'cordis']) {
    const source = join(root, preset, 'agent.cordis.yml')
    if (!existsSync(source)) continue
    result[preset] = parsePreset(source, preset, disabled)
  }
  return result
}

function presetRoot() {
  const configured = process.env.DSH_AGENT_PRESET_ROOT || process.env.FLOWIX_DSH_PRESET_ROOT
  if (configured) return configured
  try {
    return join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'config', 'agent-presets')
  } catch (_) {
    return undefined
  }
}

function parsePreset(source, preset, disabled) {
  const rows = []
  let current
  const flush = () => {
    if (current && current.name && current.name !== 'cordis:group') {
      rows.push({
        key: `preset:${preset}:${rows.length}:${current.id}`,
        id: current.id,
        name: current.name,
        enabled: !current.disabled && !disabled.has(`preset:${preset}:${rows.length}:${current.id}`),
        toggleable: true,
        removable: false,
        scope: 'preset',
        preset,
      })
    }
    current = undefined
  }
  for (const line of readFileSync(source, 'utf8').split(/\r?\n/)) {
    const idMatch = /^(\s*)- id:\s*(.+?)\s*$/.exec(line)
    if (idMatch) {
      flush()
      current = { id: cleanScalar(idMatch[2]), indent: idMatch[1].length }
      continue
    }
    if (!current) continue
    const nameMatch = /^(\s+)name:\s*(.+?)\s*$/.exec(line)
    if (nameMatch && current.name === undefined && nameMatch[1].length > current.indent) {
      current.name = cleanScalar(nameMatch[2].replace(/^!!js\s+/, ''))
      continue
    }
    const disabledMatch = /^(\s+)disabled:\s*(.+?)\s*$/.exec(line)
    if (disabledMatch && disabledMatch[1].length > current.indent) {
      current.disabled = disabledMatch[2].trim() === 'true'
    }
  }
  flush()
  return rows
}

function cleanScalar(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

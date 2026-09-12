import { assistantChunkText, isPlanSteerPromptEvent, itemFromEvent, projectHistoryMessages, projectNotifications, projectTurns, stableAssistantStreamItemId, stableItemId, stableTurnId, textOf, turnEndStatus } from './event-projector.js'

// Native adapter for Flowix's bundled DeepSeek Harness runtime.
// It deliberately imports no Flowix bridge package. The host supplies a Cordis ctx.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

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
  constructor(ctx) {
    this.ctx = ctx
    this.runtimes = new Map()
    // Agent activation is process-local and owns the session's write handle.
    // Several App Server requests can arrive while a session is already being
    // resumed (for example a command plus a history/status refresh). Keep one
    // in-flight activation per provider session so those requests converge on
    // the same Agent instead of opening a second write handle.
    this.agentResolutions = new Map()
    this.history = new Map()
    this.pendingTurns = new Map()
    this.activeTurns = new Map()
    // DSH publishes assistant chunks on the process-local agent stream. The
    // durable session/event feed only contains the final assistant/message.
    // Keep the transient attempt identity until that durable settlement arrives
    // so streaming and the final snapshot target one assistant row.
    this.assistantStreams = new Map()
    this.listeners = new Set()
    this.disposers = [
      ctx.on?.('session/event', (session, event) => { const threadId = String(session.id); this.history.set(threadId, [...(session.events || [])]); this.projectEvent(threadId, event) }),
      ctx.on?.('agent/assistant-stream', payload => this.projectAssistantStream(payload)),
      ctx.on?.('agent/status', payload => { const threadId = String(payload.agent.session.id); this.emit({ jsonrpc: '2.0', method: 'thread/status/changed', params: { threadId, status: this.status(payload.status) } }) })
    ].filter(Boolean)
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
      this.emit({
        jsonrpc: '2.0', method: 'item/agentMessage/delta',
        params: {
          threadId,
          turnId: this.activeTurns.get(threadId) || (frame.turn == null ? undefined : stableTurnId(threadId, frame.turn)),
          itemId,
          delta,
          ...(frame.index == null ? {} : { sourceSubsequence: frame.index }),
        },
      })
      return
    }
    if (frame.type === 'end') {
      const outcome = frame.outcome
      const sequence = outcome?.kind === 'committed' ? outcome.seq : undefined
      if (entry && sequence != null) state.bySequence.set(String(sequence), entry.itemId)
      if (entry && stepKey && state.byStep.get(stepKey) === entry.itemId) state.byStep.delete(stepKey)
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
    return turn == null || step == null ? undefined : state.byStep.get(`${turn}:${step}`)
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
  projectEvent(threadId, event) {
    // Goal state is a durable DSH domain event, not a model item. Publish a
    // small provider notification so transports that keep a session-level
    // watcher (for example the desktop Goal Round monitor) can observe the
    // terminal lifecycle without polling or reopening the write handle.
    if (event.type === 'goal/change') {
      this.emit({
        jsonrpc: '2.0',
        method: 'goal/changed',
        params: { threadId, sourceSeq: event.seq, change: event.data },
      })
      return
    }
    // `/plan <prompt>` also persists a user/message for DSH's steer inbox.
    // The command/run row is the canonical product timeline item; suppress
    // this model-facing duplicate in live notifications just as history does.
    if (isPlanSteerPromptEvent(this.history.get(threadId) || [], event)) return
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
        this.emit({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId, turnId: this.activeTurns.get(threadId), itemId: this.legacyAssistantStreamItemId(threadId, event), sourceSeq: event.seq, delta } })
      }
      return
    }
    const item = itemFromEvent(threadId, event)
    if (item) {
      const streamItemId = this.assistantStreamItemIdForEvent(threadId, event)
      if (streamItemId) item.id = streamItemId
      const turnId = this.activeTurns.get(threadId)
      this.emit({ jsonrpc: '2.0', method: 'item/started', params: { threadId, turnId, sourceSeq: event.seq, item } })
      if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'approval/decided') this.emit({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, turnId, sourceSeq: event.seq, item } })
    }
    if (event.type === 'turn/end') { const turnId = this.activeTurns.get(threadId) || stableTurnId(threadId, turn ?? event.seq); this.activeTurns.delete(threadId); this.emit({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turnId, sourceSeq: event.seq, turn: { id: turnId, threadId, status: turnEndStatus(event.data), items: [] } } }) }
  }

  async startThread(id, config = {}) {
    const key = String(id)
    const existing = this.liveAgent(key)
    if (existing) return this.thread(existing)
    const handle = await this.ctx.agents.create(this.agentCreateOptions(id, config))
    this.applyPermission(handle.agent, config.permissionMode)
    this.runtimes.set(String(handle.agent.session.id), handle)
    return this.thread(handle.agent)
  }

  async resumeThread(id, config = {}) {
    const key = String(id)
    const existing = this.liveAgent(key)
    if (existing) return this.thread(existing)
    const active = this.agentResolutions.get(key)
    if (active) return active.then(agent => this.thread(agent))

    const resolution = (async () => {
      // Re-check after waiting for the event loop. Another request may have
      // completed start/resume between the fast path and this task.
      const current = this.liveAgent(key)
      if (current) return current
      const handle = await this.ctx.agents.resume(this.agentResumeOptions(key, config))
      this.applyPermission(handle.agent, config.permissionMode)
      this.runtimes.set(String(handle.agent.session.id), handle)
      return handle.agent
    })()
    this.agentResolutions.set(key, resolution)
    try {
      return this.thread(await resolution)
    } finally {
      if (this.agentResolutions.get(key) === resolution) this.agentResolutions.delete(key)
    }
  }

  async forkThread(sourceId, boundarySeq, childId) {
    const source = this.liveAgent(sourceId)?.session
      || this.ctx.sessions.get(sourceId)
      || (await this.resumeThread(sourceId), this.ctx.sessions.get(sourceId))
    if (!source) throw new Error(`Session not found: ${sourceId}`)
    // A session returned by the registry can be a metadata/live view without
    // carrying its event array. Use the same durable snapshot as history/read
    // instead of assuming that `source.events` is always present.
    const snapshot = await this.eventSnapshot(sourceId)
    const events = Array.isArray(snapshot.events) ? snapshot.events : []
    const boundary = boundarySeq === undefined
      ? (Number.isInteger(Number(source.seq)) ? Number(source.seq) - 1 : (events.at(-1)?.seq ?? -1))
      : boundarySeq
    if (!Number.isInteger(Number(boundary)) || Number(boundary) < -1) throw new Error(`Invalid fork boundary: ${boundary}`)
    const boundaryIndex = Number(boundary) === -1
      ? -1
      : events.findIndex(event => Number(event.seq) === Number(boundary))
    if (Number(boundary) !== -1 && boundaryIndex < 0) throw new Error(`Invalid fork boundary: ${boundary}`)
    const boundaryEvent = boundaryIndex >= 0 ? events[boundaryIndex] : undefined
    if (boundaryEvent && ['turn/start', 'step/start', 'agent/inbox/spliced'].includes(boundaryEvent.type)) throw new Error(`Cannot fork at a non-message boundary: ${boundary}`)
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
      meta: { parentSession: sourceId, seedLength: seed.length, cwd: header.cwd, agentPreset },
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
        ...(Array.isArray(config.workspacePaths) ? { workspacePaths: config.workspacePaths } : {}),
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
    const live = this.liveAgent(id)
    if (live) return this.thread(live, includeTurns)
    // Keep thread/read on the same durable source as session/history. The
    // current DSH persistence service exposes event data through a read
    // handle; metadata-only inspection is only a legacy fallback.
    const snapshot = await this.eventSnapshot(id)
    return this.snapshotThread(id, snapshot, includeTurns)
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
        live.push({ id: String(id), parentThreadId: header?.parentSession ? String(header.parentSession) : undefined, status: 'idle', turns: [] })
      }
    }
    return live
  }

  async listTurns(id, cursor = '0', limit = 50) {
    const thread = await this.readThread(id, true)
    const start = Math.max(0, Number.parseInt(cursor, 10) || 0)
    const data = thread.turns.slice(start, start + Math.min(200, Math.max(1, limit)))
    return { data, nextCursor: start + data.length < thread.turns.length ? String(start + data.length) : null }
  }
  async listEvents(id, afterSeq = -1, limit = 200) {
    const snapshot = await this.eventSnapshot(id)
    const events = (snapshot.events || []).filter(event => Number(event.seq) > Number(afterSeq)).slice(0, Math.min(1000, Math.max(1, Number(limit) || 200)))
    const next = events.length && Number(events[events.length - 1].seq) < (snapshot.events?.at(-1)?.seq ?? -1) ? String(events[events.length - 1].seq) : null
    return { data: events, nextCursor: next }
  }

  async eventSnapshot(id) {
    const persistence = this.ctx.sessionPersistence || this.ctx.get?.('sessionPersistence') || this.ctx.get?.('sessionPersistence', false)
    let live
    live = this.runtimes.get(String(id))?.agent?.session
    if (!live) {
      try { live = this.ctx.sessions.get(id) } catch { /* the owning agent may have closed its scoped context */ }
    }
    let snapshot
    if (live && Array.isArray(live.events)) {
      // A live Session keeps appending to its event array. Never expose that
      // mutable container as a supposedly point-in-time history snapshot.
      snapshot = { header: live.header, events: [...live.events] }
    } else if (typeof persistence?.open === 'function') {
      // Current DSH exposes durable history through a read handle. `stat` (and
      // older compatibility `inspect`) only returns session metadata; it does
      // not contain the event log. Keep the handle scoped to this read so old
      // sessions are available after restart without taking write ownership.
      let handle
      try {
        handle = await persistence.open(id, 'read')
        const result = await handle.read()
        // DSH 1.6.x returns the event-state envelope. Older adapters/tests
        // returned the bare event array, so keep that shape as a narrow
        // compatibility fallback while using the current contract first.
        const events = Array.isArray(result) ? result : result?.events
        if (!Array.isArray(events)) throw new TypeError(`invalid session read result for ${id}`)
        snapshot = { header: handle.header || result?.header, events: [...events] }
      } finally {
        await handle?.close?.()
      }
    } else if (typeof persistence?.inspect === 'function') {
      // Compatibility with the pre-handle persistence API.
      snapshot = await persistence.inspect(id)
    } else if (this.history.has(id)) {
      snapshot = { events: this.history.get(id) }
    }
    if (!snapshot) throw new Error(`Session not found: ${id}`)
    return snapshot
  }

  async replayNotifications(id, afterSeq = -1, limit = 200) {
    const snapshot = await this.eventSnapshot(id)
    const allEvents = snapshot.events || []
    const eventLimit = Math.min(1000, Math.max(1, Number(limit) || 200))
    const selected = allEvents.filter(event => Number(event.seq) > Number(afterSeq)).slice(0, eventLimit)
    if (!selected.length) return { data: [], nextCursor: null }
    const lastSeq = Number(selected.at(-1).seq)
    const notifications = projectNotifications(id, allEvents).filter(event => Number(event.params?.sourceSeq) > Number(afterSeq) && Number(event.params?.sourceSeq) <= lastSeq)
    const finalSeq = Number(allEvents.at(-1)?.seq ?? -1)
    return { data: notifications, nextCursor: lastSeq < finalSeq ? String(lastSeq) : null }
  }

  async startTurn(id, input) {
    const agent = await this.resolveAgent(id)
    const nextTurn = (agent.session.events || []).reduce((max, event) => Math.max(max, Number(event.data?.turn) || 0), 0) + 1
    const turnId = stableTurnId(id, nextTurn)
    const pending = this.pendingTurns.get(id) || []
    pending.push(turnId)
    this.pendingTurns.set(id, pending)
    const content = await this.admitTurnContent(input)
    const message = { id: `message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role: 'user', content, source: { kind: 'user' } }
    agent.followup ? agent.followup(message) : agent.send(message, 'followup', true)
    return { id: turnId, threadId: id, status: 'inProgress', items: [] }
  }

  async steerTurn(id, input, clientMessageId) {
    const agent = await this.resolveAgent(id)
    const content = await this.admitTurnContent(input)
    const message = {
      id: typeof clientMessageId === 'string' && clientMessageId.trim()
        ? clientMessageId.trim()
        : `message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content,
      source: { kind: 'user' },
    }
    // DSH's steer() appends to the durable next-step inbox. It is consumed by
    // the current driver at the next step boundary and remains in the same
    // turn, which is deliberately different from followup()/turn/start.
    agent.steer
      ? agent.steer(message)
      : agent.send(message, 'next-step', true)
    return true
  }

  async interruptTurn(id) {
    const agent = this.liveAgent(id)
    if (!agent) return { interrupted: false }
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    return { interrupted: true }
  }

  activeTurnId(id) { return this.activeTurns.get(String(id)) ?? null }

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
    if (!['ask', 'never'].includes(policy)) throw new Error('policy must be "ask" or "never"')
    const agent = await this.resolveAgent(id)
    const approval = this.ctx.get?.('approval')
    if (!approval?.setPolicy) throw new Error('DSH approval service is unavailable')
    approval.setPolicy(agent, policy)
    return this.readApprovalPolicy(id)
  }

  async closeThread(id) {
    const handle = this.runtimes.get(id)
    if (handle) { this.runtimes.delete(id); await handle.dispose(); return { closed: true } }
    return { closed: false }
  }

  async archiveThread(id) {
    // DSH's official archive semantics belong to workspace-controller. This
    // only hides the durable session from DSH navigation; it does not delete
    // the session log. Keep this distinct from thread/close, which only
    // disposes an in-memory runtime.
    const controller = this.ctx.get?.('workspaceController') || this.ctx.workspaceController
    if (!controller?.archiveSession) throw new Error('DSH workspace archive service is unavailable')
    const result = await controller.archiveSession({ sessionId: id })
    const archived = Array.isArray(result?.archivedSessionIds)
      ? result.archivedSessionIds.map(String).includes(String(id))
      : true
    return { archived }
  }

  async executeCommand(id, line, submittedAttachments = []) {
    const agent = await this.resolveAgent(id)
    const commands = this.ctx.commands || this.ctx.get?.('commands')
    if (!commands?.execute) throw new Error('DSH command service is unavailable')
    const execution = await commands.execute(agent, line, submittedAttachments, new AbortController().signal)
    if (execution === undefined) throw new Error(`Unknown DSH command: ${line}`)
    const effects = this.commandEffects(line, submittedAttachments, execution)
    // The native composition does not have the Web download route. Return a
    // transport-friendly export payload while still executing/logging the DSH
    // command through ctx.commands above.
    if (/^\/export(?:[\t\n\r ]*)$/u.test(line)) {
      const snapshot = await this.eventSnapshot(id)
      return {
        execution,
        effects,
        export: {
          filename: `dsh-session-${String(id).replace(/[^a-z0-9_-]+/giu, '_')}.json`,
          content: JSON.stringify({ sessionId: String(id), events: snapshot.events || [] }, null, 2),
        },
      }
    }
    return { execution, effects }
  }

  /**
   * Describe DSH-owned work that may outlive command/done. The desktop
   * transport consumes this effect instead of maintaining a second parser for
   * command names and guessing with a timeout whether a turn will appear.
   */
  commandEffects(line, attachments, execution) {
    const result = execution?.result && typeof execution.result === 'object'
      ? execution.result
      : execution
    if (result?.kind === 'error') return { turn: 'none' }

    const parts = String(line || '').trim().split(/\s+/u)
    const name = String(parts.shift() || '').replace(/^\//u, '').toLowerCase()
    const args = parts.join(' ').trim()

    if (name === 'plan') {
      if (args.toLowerCase() === 'off' && attachments.length === 0) return { turn: 'none' }
      return args !== '' || attachments.length > 0 ? { turn: 'steer' } : { turn: 'none' }
    }

    if (name === 'goal') {
      const control = args.toLowerCase()
      if (args === '' || control === 'clear' || control === 'pause') return { turn: 'none' }
      // `/goal resume` and create/edit operations wake the native
      // goal-round-driver. Attachments additionally create one ordinary
      // followup before the next goal round.
      if (control === 'resume' || control !== 'edit' || /^edit\s+/u.test(args)) {
        return { turn: 'goal-round', ...(attachments.length > 0 ? { followup: true } : {}) }
      }
    }
    return { turn: 'none' }
  }

  async listSkills(id) {
    const agent = await this.resolveAgent(id)
    const presets = this.ctx.get?.('agentPresets')
    const registry = presets?.serviceFor?.(agent, 'skills')
      || this.ctx.skills
      || this.ctx.get?.('skills')
    if (!registry?.list) throw new Error('DSH skill service is unavailable')
    const cwd = agent.session?.header?.cwd
    const skills = await registry.list({ cwd, scope: agent })
    return {
      skills: (Array.isArray(skills) ? skills : skills?.candidates || [])
        .filter(skill => skill?.invocation?.userInvocable !== false)
        .map(skill => ({
          name: String(skill.name),
          description: String(skill.description || ''),
          ...(skill.whenToUse === undefined ? {} : { whenToUse: String(skill.whenToUse) }),
          ...(skill.invocation?.modelInvocable === undefined ? {} : { modelInvocable: Boolean(skill.invocation.modelInvocable) }),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }
  }

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
    if (!snapshot) throw new Error(`Session not found: ${id}`)
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
    return { profile: process.env.DSH_PROFILE || null, appServer: 'dsh-appserver', protocolVersion: 1 }
  }

  statusReport() {
    return { activeThreads: this.runtimes.size, threads: this.runtimes.size, initialized: true }
  }

  capabilitiesReport() {
    return { protocolVersion: 1, capabilities: ['runtime-events', 'session-control', 'session-archive', 'session-dispose', 'run-cancel', 'profile', 'credentials-management', 'model-settings-management'] }
  }

  describeCredentials(reference) {
    const credentials = this.ctx.get?.('credentials')
    if (!credentials?.describe) throw new Error('DSH credentials service is unavailable')
    return credentials.describe(this.validateCredentialReference(reference))
  }

  async setCredential(reference, value) {
    const credentials = this.ctx.get?.('credentials')
    if (!credentials?.set) throw new Error('DSH credentials service is unavailable')
    const ref = this.validateCredentialReference(reference)
    if (typeof value !== 'string' || value === '') throw new Error('value must be a non-empty string')
    await credentials.set(ref, value)
    return this.describeCredentials(ref)
  }

  async unsetCredential(reference) {
    const credentials = this.ctx.get?.('credentials')
    if (!credentials?.unset) throw new Error('DSH credentials service is unavailable')
    const ref = this.validateCredentialReference(reference)
    await credentials.unset(ref)
    return this.describeCredentials(ref)
  }

  validateCredentialReference(reference) {
    if (typeof reference !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) throw new Error('reference must be an environment-variable name')
    return reference
  }

  describeModels() {
    const settings = this.ctx.get?.('settings')
    if (!settings?.describe) return { revision: 0, providers: {}, applies: [] }
    let descriptor
    try { descriptor = settings.describe({ redactSecrets: true }).find(item => item.ns === 'llm-pi-ai') } catch (_) { descriptor = undefined }
    if (!descriptor) return { revision: 0, providers: {}, applies: [] }
    const user = descriptor.user && typeof descriptor.user === 'object' && !Array.isArray(descriptor.user) ? descriptor.user : {}
    return { revision: descriptor.revision, providers: user.providers && typeof user.providers === 'object' && !Array.isArray(user.providers) ? user.providers : {}, applies: descriptor.applies }
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
      if (!llm?.listConfigurableProviders || !llm?.listModels) throw new Error('DSH LLM provider directory is unavailable')
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
    if (!llm?.discoverModels) throw new Error('DSH LLM discovery service is unavailable')
    return { models: await llm.discoverModels('llm-pi-ai', request && typeof request === 'object' ? request : {}) }
  }

  async configureModel(route, profile, expectedRevision) {
    this.validateRoute(route)
    const settings = this.ctx.get?.('settings')
    if (!settings?.mutate) throw new Error('DSH settings service is unavailable')
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('profile must be an object')
    this.validateRevision(expectedRevision)
    await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', route], value: profile }], expectedRevision)
    return this.describeModels()
  }

  async deleteModel(route, expectedRevision) {
    this.validateRoute(route)
    const settings = this.ctx.get?.('settings')
    if (!settings?.mutate) throw new Error('DSH settings service is unavailable')
    this.validateRevision(expectedRevision)
    await settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', route] }], expectedRevision)
    return this.describeModels()
  }

  validateRoute(route) {
    if (typeof route !== 'string' || route === '') throw new Error('route must be a non-empty string')
    if (route === '__proto__' || route === 'prototype' || route === 'constructor') throw new Error('invalid provider route')
  }

  validateRevision(revision) {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) throw new Error('expectedRevision must be a non-negative integer')
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
    return { id, parentThreadId: session.header?.parentSession ? String(session.header.parentSession) : undefined, status: this.status(status), turns: includeTurns ? projectTurns(id, session.events || [], messages, { preserveCompactedHistory: true }) : [] }
  }
  snapshotThread(id, snapshot, includeTurns) { const events = snapshot.events || []; return { id, parentThreadId: snapshot.header?.parentSession ? String(snapshot.header.parentSession) : undefined, status: 'idle', turns: includeTurns ? projectTurns(id, events, [], { preserveCompactedHistory: true }) : [] } }
  status(status) { return typeof status === 'string' && status.includes('run') ? 'running' : status === 'closed' ? 'closed' : 'idle' }
  textOf(value) { return textOf(value) }
  textFromInput(input) { if (typeof input === 'string') return input; if (Array.isArray(input)) { const text = input.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n'); return text || JSON.stringify(input) } return typeof input?.text === 'string' ? input.text : JSON.stringify(input) }
  async admitTurnContent(input) {
    const text = this.textFromInput(input)
    const rawAttachments = input && typeof input === 'object' && !Array.isArray(input) && Array.isArray(input.attachments)
      ? input.attachments
      : []
    if (rawAttachments.length === 0) return [{ type: 'text', text }]
    const parts = rawAttachments.map((attachment, index) => {
      if (attachment?.type !== 'image' || typeof attachment.mediaType !== 'string' || typeof attachment.data !== 'string') {
        throw new Error(`Unsupported turn attachment at index ${index}`)
      }
      return {
        type: 'image',
        mediaType: attachment.mediaType,
        data: attachment.data,
        ...(typeof attachment.name === 'string' ? { name: attachment.name } : {}),
      }
    })
    const store = this.ctx.attachments || this.ctx.get?.('attachments')
    if (!store?.admitPromptContent) throw new Error('DSH attachment service is unavailable')
    return store.admitPromptContent([{ type: 'text', text }, ...parts])
  }
  dispose() {
    for (const dispose of this.disposers) dispose?.()
    for (const handle of this.runtimes.values()) void handle.dispose().catch(() => {})
    this.runtimes.clear()
    this.agentResolutions.clear()
    this.listeners.clear()
  }
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

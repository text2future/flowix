import { assistantChunkText, stableAssistantStreamItemId, stableItemId, stableTurnId, textOf, turnEndError, turnEndStatus } from './event-normalizer.js'
export { assistantChunkText, stableAssistantStreamItemId, stableItemId, stableTurnId, textOf, turnEndError, turnEndStatus } from './event-normalizer.js'
import { normalizeItem } from '../services/item-lifecycle-service.js'

// Message content and protocol blocks share an array in DSH's assistant
// event. `textOf()` is intentionally a generic fallback for tool results and
// unknown payloads, but it must not be used to build assistant display text:
// a tool-call block has no `text` field and would therefore be serialized as
// JSON into the conversation. Tool calls have their own durable
// `tool/call`/`tool/result` projection and are never assistant prose.
function messageText(value) {
  const payload = value?.message ?? value
  if (Array.isArray(payload?.content)) {
    return payload.content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('')
  }
  if (typeof payload?.content === 'string') return payload.content
  if (typeof payload?.text === 'string') return payload.text
  return typeof payload === 'string' ? payload : ''
}

function parseToolInput(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch (_) {
    return undefined
  }
}

function isCompactionCheckpoint(event, payload) {
  const source = payload?.source
  return event?.type === 'user/message'
    && event?.surfaceOp?.op === 'replace'
    && source?.kind === 'plugin'
    && source?.plugin === 'compact'
}

function jsonLineValue(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'string' ? parsed : text
  } catch (_) {
    return text.replace(/^['"]|['"]$/gu, '')
  }
}

function goalObjective(content) {
  const match = /Objective:\s*("(?:\\.|[^"\\])*"|.+?)(?=\s+Round:|\n|$)/u.exec(content)
  return match ? jsonLineValue(match[1]) : ''
}

function goalRound(content) {
  const match = /Round:\s*(\d+)\s*\/\s*(\d+)/u.exec(content)
  return match ? { round: Number(match[1]), maxRounds: Number(match[2]) } : undefined
}

/**
 * DSH goal prompts are model-facing control messages, not human messages.
 * Their source envelope is the stable discriminator; the XML tags are kept as
 * a defensive check for old/replayed logs. Return a short display projection
 * and never expose the continuation/wrap-up instructions to Flowix users.
 */
function goalControlFromMessage(event, payload, content = textOf(payload)) {
  if (event?.type !== 'user/message') return undefined
  const source = payload?.source
  const isRound = source?.kind === 'goal'
    && Number(source.round) > 0
    && /<goal_round>[\s\S]*<\/goal_round>/u.test(content)
  const isToolGoalNotice = source?.kind === 'plugin'
    && source?.plugin === 'tool-goal'
    && source?.form === 'notice'
  const isComplete = isToolGoalNotice && /<goal_complete>[\s\S]*<\/goal_complete>/u.test(content)
  const isBlocked = isToolGoalNotice && /<goal_blocked>[\s\S]*<\/goal_blocked>/u.test(content)
  if (!isRound && !isComplete && !isBlocked) return undefined

  const objective = goalObjective(content) || String(source?.summary || '')
    .replace(/^(?:complete|blocked):\s*/iu, '')
    .trim()
  if (isRound) {
    const round = goalRound(content)
    const suffix = round ? `（第 ${round.round}/${round.maxRounds} 轮）` : ''
    return {
      messageType: 'goal-round',
      content: `目标执行中：${objective || '未命名目标'}${suffix}`,
    }
  }
  return {
    messageType: isComplete ? 'goal-complete' : 'goal-blocked',
    content: `${isComplete ? '目标已完成' : '目标已阻塞'}：${objective || '未命名目标'}`,
  }
}

// The native `/plan` command persists this plugin notice after switching the
// session mode. It is control-plane state, not a user-authored message; the
// command/run row is the single user-facing representation of the action.
function isPlanModeNoticeEvent(event, payload = event?.data) {
  return event?.type === 'user/message'
    && payload?.source?.kind === 'plugin'
    && payload?.source?.plugin === 'plan-mode'
    && payload?.source?.form === 'notice'
}

/**
 * DSH transports several model/runtime notices as `user/message` events so
 * they can be fed back into the model. They are not user-authored transcript
 * messages. Prefer the durable source marker over matching their text: relay
 * messages and subagent settlement notices can contain arbitrary tool output.
 * The legacy text checks below remain useful for old events without source
 * metadata.
 */
function isHiddenSystemUserMessage(event, payload, content) {
  if (event?.type !== 'user/message') return false

  const source = payload?.source
  if (source?.kind === 'agent-instructions'
    || source?.kind === 'agent-message'
    || source?.kind === 'subagent-settled'
    || source?.kind === 'skill-catalog'
    || source?.kind === 'skill-invocation') {
    return true
  }
  if (source?.kind === 'plugin' && source?.plugin === '@deepseek-ai/dsh-system-prompt') {
    return true
  }
  return content.startsWith('<system-reminder>') || content.startsWith('Current runtime context.')
}

export function messageFromEvent(threadId, event, toolNames = undefined, display = undefined) {
  if (event.type === 'tool/call' || event.type === 'tool/result') {
    const data = event.data || {}
    const callId = data.callId || data.toolCallId || data.id || data.message?.source?.callId
    const result = event.type === 'tool/result'
      ? (data.message?.content ?? data.result ?? data.content ?? data)
      : undefined
    const input = event.type === 'tool/call' ? (data.arguments ?? data.input) : undefined
    const resultText = result === undefined ? '' : textOf(result)
    return {
      id: String(callId || `${threadId}-tool-${event.seq}`),
      role: 'tool',
      content: result === undefined ? textOf(input ?? data) : resultText,
      llmContent: null,
      systemReminderDirectory: null,
      sourceSeq: Number(event.seq),
      timestamp: eventTimestamp(event),
      sourceSequence: Number(event.seq),
      // A call without its result is still in progress in the durable DSH
      // history. The result event closes the same projected tool row.
      isLoading: event.type === 'tool/call',
      // Preserve the provider event envelope for consumers that need timing
      // or other raw tool metadata. This is response projection only; the
      // durable event log remains the source of truth.
      toolCall: event.type === 'tool/call' ? event : null,
      toolResult: event.type === 'tool/result' ? event : null,
      toolCallId: callId ? String(callId) : null,
      toolName: data.name || data.toolName || toolNames?.get?.(String(callId)) || null,
      toolData: result === undefined ? null : resultText,
      toolInput: parseToolInput(input) ?? null,
      toolCalls: null,
      reasoning: null,
      isCompleted: event.type === 'tool/result',
      errorDetails: null,
      isCollapsed: null,
      codexTurnId: null,
    }
  }
  const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : undefined
  if (!role) return undefined
  const payload = role === 'assistant' ? event.data?.message ?? event.data : event.data
  if (isPlanModeNoticeEvent(event, payload)) return undefined
  const compactionCheckpoint = isCompactionCheckpoint(event, payload)
  const blocks = Array.isArray(payload?.content) ? payload.content : []
  const toolCalls = blocks.filter(block => block?.type === 'tool-call')
  let content = blocks.length ? blocks.filter(block => block?.type === 'text').map(block => block.text || '').join('') : textOf(payload)
  const goalControl = role === 'user' ? goalControlFromMessage(event, payload, content) : undefined
  if (role === 'user') {
    if (goalControl) content = goalControl.content
    if (!goalControl && isHiddenSystemUserMessage(event, payload, content)) return undefined
    content = content.split('\n<## CONTEXT PROMPT ##>')[0]
  }
  // The summary is model context, not a user-facing transcript message. The
  // durable command result is supplied by projectHistoryMessages instead.
  if (compactionCheckpoint) content = display?.compactionText || ''
  if (!content.trim() && !toolCalls.length && !compactionCheckpoint) return undefined
  return {
    id: String(payload?.id || `${threadId}-message-${event.seq}`),
    role: compactionCheckpoint || goalControl ? 'system' : role,
    ...(compactionCheckpoint ? { messageType: 'context-compaction' } : {}),
    ...(goalControl ? { messageType: goalControl.messageType } : {}),
    ...(!compactionCheckpoint && !goalControl && display?.messageType ? { messageType: display.messageType } : {}),
    content,
    llmContent: null,
    systemReminderDirectory: null,
    sourceSeq: Number(event.seq),
    timestamp: eventTimestamp(event),
    sourceSequence: Number(event.seq),
    isLoading: false,
    toolCallId: null,
    toolName: null,
    toolData: null,
    toolInput: null,
    toolCalls: toolCalls.length ? toolCalls : null,
    reasoning: null,
    isCompleted: true,
    errorDetails: null,
    isCollapsed: null,
    codexTurnId: null,
  }
}

// DSH's session log is append-only, but its model-visible conversation is a
// surface projection. A compaction checkpoint is a user/message event whose
// `surfaceOp` replaces the shadowed surface nodes; the old events intentionally
// remain in the audit log. Model-surface consumers use that replacement;
// transcript consumers opt into the append-only timeline below.
const SURFACE_MESSAGE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

function isSurfaceMessageEvent(event) {
  return SURFACE_MESSAGE_TYPES.has(event?.type)
}

function eventSequence(event) {
  const sequence = Number(event?.seq)
  return Number.isSafeInteger(sequence) ? sequence : null
}

function commandName(event) {
  const name = event?.data?.name
  return typeof name === 'string' && name.trim() ? name.trim() : 'command'
}

function commandId(event) {
  const value = event?.data?.commandId
  return value == null ? undefined : String(value)
}

function isUserCompactCommand(event) {
  return event?.type === 'command/run'
    && commandName(event).toLowerCase() === 'compact'
    && event.data?.source?.kind === 'user'
}

function compactionCommandId(event) {
  const source = event?.data?.source
  const value = source?.sourceCommandId || source?.commandId
  return value == null ? undefined : String(value)
}

function compactionResultText(checkpoint, events) {
  if (!isCompactionCheckpoint(checkpoint, checkpoint?.data)) return ''
  const sourceCommandId = compactionCommandId(checkpoint)
  const checkpointSequence = eventSequence(checkpoint)
  const done = (Array.isArray(events) ? events : []).find(event =>
    event.type === 'command/done'
    && (sourceCommandId === undefined || commandId(event) === sourceCommandId)
    && eventSequence(event) !== null
    && eventSequence(event) >= checkpointSequence,
  )
  return done ? commandResultText(done) : ''
}

function compactCommandIds(events) {
  const source = Array.isArray(events) ? events : []
  const compactRuns = source.filter(event =>
    event.type === 'command/run' && commandName(event).toLowerCase() === 'compact',
  )
  const ids = new Set()
  for (const event of source) {
    if (!isCompactionCheckpoint(event, event?.data)) continue
    const explicitId = compactionCommandId(event)
    if (explicitId !== undefined) {
      const done = source.find(candidate =>
        candidate.type === 'command/done'
        && commandId(candidate) === explicitId
        && candidate.data?.kind !== 'error'
      )
      if (done) ids.add(explicitId)
      continue
    }
    const checkpointSequence = eventSequence(event)
    const fallback = compactRuns
      .filter(run => eventSequence(run) !== null && eventSequence(run) < checkpointSequence)
      .at(-1)
    if (fallback) {
      const fallbackId = commandId(fallback) || `seq-${fallback.seq}`
      const done = source.find(candidate =>
        candidate.type === 'command/done'
        && (commandId(candidate) || `seq-${candidate.seq}`) === fallbackId
        && candidate.data?.kind !== 'error'
      )
      if (done) ids.add(fallbackId)
    }
  }
  return ids
}

function isPlanSteerCommand(event) {
  if (event?.type !== 'command/run' || commandName(event) !== 'plan') return false
  const args = typeof event.data?.args === 'string' ? event.data.args.trim() : ''
  return args !== '' && args.toLowerCase() !== 'off'
}

function userMessageText(event) {
  if (event?.type !== 'user/message') return ''
  const payload = event.data
  const blocks = Array.isArray(payload?.content) ? payload.content : []
  return blocks.length
    ? blocks.filter(block => block?.type === 'text').map(block => block.text || '').join('')
    : textOf(payload)
}

/**
 * `/plan <prompt>` calls DSH's native `agent.steer()`. The following
 * user/message is the real model prompt, but the command row is the canonical
 * user-facing representation of the action. Track the prompt event so the
 * transcript does not render it a second time.
 */
function planSteerUserSequences(events) {
  const targets = new Map()
  const source = Array.isArray(events) ? events : []
  for (const run of source.filter(isPlanSteerCommand)) {
    const runSequence = eventSequence(run)
    if (runSequence === null) continue
    const prompt = String(run.data.args).trim()
    const done = source.find(event =>
      event.type === 'command/done'
      && commandId(event) === commandId(run)
      && eventSequence(event) !== null
      && eventSequence(event) >= runSequence,
    )
    const doneSequence = done ? eventSequence(done) : runSequence
    const user = source.find(event => {
      const sequence = eventSequence(event)
      if (sequence === null || sequence <= doneSequence || event.type !== 'user/message') return false
      if (event.data?.source?.kind && event.data.source.kind !== 'user') return false
      return userMessageText(event).trim() === prompt
    })
    if (user) targets.set(eventSequence(user), commandId(run))
  }
  return targets
}

/** Return whether a user/message is the model-facing payload of `/plan`. */
export function isPlanSteerPromptEvent(events, event) {
  return event?.type === 'user/message'
    && planSteerUserSequences(events).has(eventSequence(event))
}

function commandResultText(event) {
  const text = typeof event?.data?.text === 'string' ? event.data.text.trim() : ''
  if (text) return text
  return event?.data?.kind === 'error' ? 'Command failed.' : 'Command completed.'
}

/**
 * Build the command lifecycle from the complete event-log snapshot before a
 * page is projected. A command is one DSH operation identified by commandId;
 * command/run and command/done are only its persisted lifecycle edges.
 */
function commandAggregates(events) {
  const aggregates = new Map()
  for (const event of Array.isArray(events) ? events : []) {
    if (event.type !== 'command/run' && event.type !== 'command/done') continue
    const id = commandId(event) || `seq-${event.seq}`
    const current = aggregates.get(id) || { id }
    if (event.type === 'command/run') {
      current.run = event
      current.name = commandName(event)
      current.args = typeof event.data?.args === 'string' ? event.data.args : ''
    } else {
      current.done = event
    }
    aggregates.set(id, current)
  }
  return aggregates
}

function commandMessagesFromEvents(threadId, events, allEvents = events) {
  const source = Array.isArray(events) ? events : []
  const aggregates = commandAggregates(allEvents)
  const steerSequences = planSteerUserSequences(allEvents)
  const compactCommands = compactCommandIds(allEvents)
  const messages = []
  for (const event of source) {
    if (event.type === 'command/run') {
      // Every user-issued DSH command has one canonical command-input row.
      // `/plan <text>` also creates a model-facing steer user/message, but
      // that internal prompt is filtered below so it cannot duplicate this
      // row in the transcript.
      const id = commandId(event) || `seq-${event.seq}`
      // `compact` keeps its command/run row while command/done is folded into
      // the checkpoint below. This is a projection-only row; the append-only
      // DSH event log is unchanged.
      if (!compactCommands.has(id) || isUserCompactCommand(event)) {
        const aggregate = aggregates.get(id) || { id, run: event }
        const done = aggregate.done
        messages.push({
          id: `dsh-command:${id}:input`,
          role: 'user',
          messageType: 'dsh-command',
          content: `/${aggregate.name || commandName(event)}${aggregate.args || ''}`,
          llmContent: null,
          systemReminderDirectory: null,
          sourceSeq: Number(event.seq),
          timestamp: eventTimestamp(event),
          sourceSequence: Number(event.seq),
          isLoading: !done,
          isCompleted: Boolean(done),
          toolCallId: null,
          toolName: null,
          toolData: null,
          toolInput: null,
          toolCalls: null,
          reasoning: null,
          errorDetails: null,
          isCollapsed: null,
          codexTurnId: null,
        })
      }
      continue
    }
    if (event.type === 'command/done') {
      const id = commandId(event) || `seq-${event.seq}`
      if (compactCommands.has(id)) continue
      const aggregate = aggregates.get(id) || { id, done: event }
      const done = aggregate.done || event
      messages.push({
        id: `dsh-command:${id}:result`,
        role: 'system',
        messageType: 'dsh-command-result',
        content: commandResultText(done),
        llmContent: null,
        systemReminderDirectory: null,
        sourceSeq: Number(event.seq),
        timestamp: eventTimestamp(event),
        sourceSequence: Number(event.seq),
        isLoading: false,
        isCompleted: true,
        toolCallId: null,
        toolName: null,
        toolData: null,
        toolInput: null,
        toolCalls: null,
        reasoning: null,
        errorDetails: done.data?.kind === 'error' ? { category: 'unknown', retryable: false, upstreamMessage: commandResultText(done) } : null,
        isCollapsed: null,
        codexTurnId: null,
      })
      continue
    }
  }
  return { messages, steerSequences }
}

/**
 * Return the visible DSH surface event sequences for an event-log snapshot.
 * Older fixtures and pre-surface sessions have no markers and retain their
 * historical "all message events are visible" behavior.
 */
function visibleSurfaceEventSequences(events) {
  const source = Array.isArray(events) ? events : []
  const surfaceEvents = source.filter(isSurfaceMessageEvent)
  const hasSurfaceMarkers = surfaceEvents.some(event => event.surfaceOp !== undefined)
  if (!hasSurfaceMarkers) return null

  const visible = []
  for (const event of surfaceEvents) {
    const sequence = eventSequence(event)
    if (sequence === null) continue
    const operation = event.surfaceOp
    if (operation === 'append' || operation === undefined) {
      visible.push(sequence)
      continue
    }
    if (operation?.op !== 'replace') continue

    const start = Number(operation.start)
    const end = Number(operation.end)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) continue
    for (let index = visible.length - 1; index >= 0; index -= 1) {
      if (visible[index] >= start && visible[index] <= end) visible.splice(index, 1)
    }
    visible.push(sequence)
  }
  return new Set(visible)
}

function surfaceEventSequences(events) {
  const visible = visibleSurfaceEventSequences(events)
  if (visible === null) return null

  // Tool calls are audit events rather than surface nodes. Keep a call only
  // when its result remains on the surface, so a compacted call/result pair is
  // removed together while an in-flight call can still be represented when a
  // history snapshot contains no result yet.
  const visibleCallIds = new Set()
  for (const event of events || []) {
    if (!visible.has(eventSequence(event))) continue
    if (event.type !== 'tool/result') continue
    const data = event.data || {}
    const message = data.message || {}
    const callId = data.callId || data.toolCallId || data.id || message.source?.callId
    if (callId != null) visibleCallIds.add(String(callId))
  }

  return { visible, visibleCallIds }
}

function reasoningMessageFromAssistant(threadId, event, payload, block, index) {
  const assistantId = String(payload?.id || `${threadId}-message-${event.seq}`)
  return {
    id: `${assistantId}:reasoning:${index}`,
    role: 'reasoning',
    content: typeof block?.text === 'string' ? block.text : textOf(block),
    llmContent: null,
    systemReminderDirectory: null,
    sourceSeq: Number(event.seq),
    timestamp: eventTimestamp(event),
    sourceSequence: Number(event.seq),
    isLoading: false,
    toolCallId: null,
    toolName: null,
    toolData: null,
    toolInput: null,
    toolCalls: null,
    reasoning: null,
    isCompleted: true,
    errorDetails: null,
    isCollapsed: null,
    codexTurnId: null,
  }
}

/** Project one persisted DSH event into all Flowix-visible messages. */
export function messagesFromEvent(threadId, event, toolNames = undefined, display = undefined) {
  const message = messageFromEvent(threadId, event, toolNames, display)
  if (!message || event.type !== 'assistant/message') return message ? [message] : []

  const payload = event.data?.message ?? event.data
  const blocks = Array.isArray(payload?.content) ? payload.content : []
  const reasoning = blocks
    .map((block, index) => block?.type === 'reasoning' ? reasoningMessageFromAssistant(threadId, event, payload, block, index) : null)
    .filter(Boolean)
  if (reasoning.length === 0) return [message]

  const firstReasoningIndex = blocks.findIndex(block => block?.type === 'reasoning')
  const firstTextIndex = blocks.findIndex(block => block?.type === 'text' || block?.type === 'tool-call')
  if (firstTextIndex < 0 || firstReasoningIndex < firstTextIndex) return [...reasoning, message]
  return [message, ...reasoning]
}

function mergeToolHistoryMessages(existing, incoming) {
  const incomingCompleted = incoming.isCompleted === true
  const existingCompleted = existing.isCompleted === true
  return {
    ...existing,
    id: existing.id,
    content: incomingCompleted || !existingCompleted ? incoming.content : existing.content,
    timestamp: (incomingCompleted || !existingCompleted) && incoming.timestamp ? incoming.timestamp : existing.timestamp,
    sourceSeq: Math.max(Number(existing.sourceSeq) || 0, Number(incoming.sourceSeq) || 0),
    sourceSequence: Math.max(Number(existing.sourceSequence) || 0, Number(incoming.sourceSequence) || 0),
    toolCallId: existing.toolCallId || incoming.toolCallId,
    toolName: existing.toolName || incoming.toolName,
    toolData: incoming.toolData || existing.toolData,
    toolInput: existing.toolInput || incoming.toolInput,
    toolCall: existing.toolCall || incoming.toolCall,
    toolResult: existing.toolResult || incoming.toolResult,
    isLoading: incomingCompleted ? false : existing.isLoading,
    isCompleted: existingCompleted || incomingCompleted,
  }
}

function historyErrorMessageFromTurnEnd(threadId, event, failure) {
  return {
    id: `${threadId}-turn-${event.data?.turn ?? event.seq}-error`,
    role: 'assistant',
    content: failure.message,
    llmContent: null,
    sourceSeq: Number(event.seq),
    timestamp: eventTimestamp(event),
    sourceSequence: Number(event.seq),
    isLoading: false,
    toolCallId: null,
    toolName: null,
    toolData: null,
    toolInput: null,
    toolCalls: null,
    reasoning: null,
    isCompleted: true,
    errorDetails: failure.details,
    isCollapsed: null,
    codexTurnId: null,
  }
}

/**
 * Project the durable event log into the message shape consumed by Flowix.
 * DSH stores tool calls and results as separate audit events, while Flowix
 * renders one tool row; merge those events before pagination.
 */
export function projectHistoryMessages(
  threadId,
  events,
  toolNames = undefined,
  surfaceEvents = events,
  options = undefined,
) {
  const messages = []
  const toolIndexes = new Map()
  // DSH's surface replacement controls what the model sees after compaction.
  // Flowix has a separate user-facing timeline projection: it keeps the
  // audit/history rows and appends the compaction checkpoint. Do not turn a
  // provider context rewrite into a destructive UI history rewrite.
  const preserveCompactedHistory = options?.preserveCompactedHistory === true
  const surface = preserveCompactedHistory
    ? null
    : surfaceEventSequences(surfaceEvents)
  const visibleSequences = surface?.visible
  const visibleCallIds = surface?.visibleCallIds
  const commandProjection = commandMessagesFromEvents(events, surfaceEvents)
  const compactionTextsBySequence = new Map()
  for (const event of surfaceEvents || []) {
    if (!isCompactionCheckpoint(event, event?.data)) continue
    const text = compactionResultText(event, surfaceEvents)
    if (text) compactionTextsBySequence.set(eventSequence(event), text)
  }
  const commandRowsBySequence = new Map()
  for (const message of commandProjection.messages) {
    commandRowsBySequence.set(message.sourceSequence, [
      ...(commandRowsBySequence.get(message.sourceSequence) || []),
      message,
    ])
  }
  for (const event of events || []) {
    const sequence = eventSequence(event)
    if (visibleSequences) {
      if (event.type === 'tool/call') {
        const data = event.data || {}
        const callId = data.callId || data.toolCallId || data.id || data.message?.source?.callId
        // A result is the normal surface node for a tool. A call without a
        // result is retained only if it was not shadowed by a replacement;
        // this keeps incomplete in-flight history readable.
        if (callId != null && visibleCallIds.has(String(callId))) {
          // Continue to the normal tool-call projection below.
        } else if (sequence === null || visibleSequences.has(sequence)) {
          // The call itself may be the only durable row for an in-flight tool.
        } else {
          continue
        }
      } else if (isSurfaceMessageEvent(event) && (sequence === null || !visibleSequences.has(sequence))) {
        continue
      }
    }
    if (commandRowsBySequence.has(sequence)) {
      messages.push(...commandRowsBySequence.get(sequence))
    }
    if (event.type === 'command/run' || event.type === 'command/done') continue
    if (event.type === 'user/message' && commandProjection.steerSequences.has(sequence)) {
      // The matching user/message is the model-facing payload of
      // `/plan <prompt>`. The command/run row is the canonical transcript
      // representation, so do not render this internal duplicate.
      continue
    }
    if (event.type === 'turn/end') {
      const failure = turnEndError(event.data)
      if (failure) messages.push(historyErrorMessageFromTurnEnd(threadId, event, failure))
      continue
    }
    if (event.type === 'tool/call' || event.type === 'tool/result') {
      const message = messageFromEvent(threadId, event, toolNames)
      if (!message) continue
      const callId = message.toolCallId
      const previous = callId ? toolIndexes.get(callId) : undefined
      if (previous === undefined) {
        if (callId) toolIndexes.set(callId, messages.length)
        messages.push(message)
      } else {
        messages[previous] = mergeToolHistoryMessages(messages[previous], message)
      }
      continue
    }
    messages.push(...messagesFromEvent(
      threadId,
      event,
      toolNames,
      {
        ...(compactionTextsBySequence.has(sequence)
          ? { compactionText: compactionTextsBySequence.get(sequence) }
          : {}),
      },
    ))
  }
  return messages
}

function eventTimestamp(event) {
  const value = event.time ?? event.timestamp ?? event.createdAt
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return ''
}

// `assistant/chunk` is a transport event, not a display message. Its payload
// contains pi-ai protocol control blocks (block-start/end, reasoning-delta,
// usage and finish) as well as user-visible text-delta blocks. Never pass the
// envelope through textOf(): doing so serializes the whole protocol object and
// leaks it into the conversation UI.
export function itemFromEvent(threadId, event, toolNames = undefined) {
  const types = { 'user/message': 'userMessage', 'assistant/message': 'agentMessage', 'tool/call': 'toolCall', 'tool/result': 'toolResult', 'approval/asked': 'approvalRequest', 'approval/decided': 'approvalRequest' }
  const type = types[event.type]
  if (!type) return undefined
  if (event.type === 'approval/asked') return { id: stableItemId(threadId, event), type, sourceSeq: event.seq, status: 'inProgress', toolName: event.data?.toolName, callId: event.data?.callId, reason: event.data?.reason }
  if (event.type === 'approval/decided') return { id: stableItemId(threadId, event), type, sourceSeq: event.seq, status: 'completed', outcome: event.data?.outcome }
  const data = event.data || {}
  if (event.type === 'tool/call') {
    return {
      id: stableItemId(threadId, event), type, sourceSeq: event.seq, status: 'inProgress',
      callId: data.callId || data.id, toolName: data.name || data.toolName,
      input: data.arguments ?? data.input ?? {}, text: textOf(data.arguments ?? data.input ?? {}),
    }
  }
  if (event.type === 'tool/result') {
    const message = data.message || {}
    const callId = data.callId || data.toolCallId || data.id || message.source?.callId
    return {
      id: stableItemId(threadId, event), type, sourceSeq: event.seq, status: 'completed',
      callId, toolName: data.name || data.toolName || toolNames?.get?.(String(callId)),
      result: message.content ?? data.result ?? data.content ?? data,
      text: textOf(message.content ?? data.result ?? data.content ?? data),
    }
  }
  // Keep the live App Server item projection consistent with history
  // projection. In particular, an assistant message can contain both a text
  // block and several tool-call blocks. Only the text blocks belong in the
  // assistant item; tool calls are emitted separately from their durable
  // tool/call events.
  const message = messageFromEvent(threadId, event, toolNames)
  if (!message || message.messageType === 'context-compaction') return undefined
  return {
    id: stableItemId(threadId, event), type, sourceSeq: event.seq, status: 'completed',
    text: message.content,
    ...(message.messageType ? { messageType: message.messageType } : {}),
  }
}

function threadItemFromHistoryMessage(message) {
  const role = message?.role
  const type = role === 'user'
    ? 'userMessage'
    : role === 'assistant'
      ? 'agentMessage'
      : role === 'tool'
        ? 'toolResult'
        : 'systemMessage'
  return {
    id: String(message.id),
    type,
    text: String(message.content || ''),
    status: 'completed',
    ...(message.messageType ? { messageType: String(message.messageType) } : {}),
    ...(Number.isSafeInteger(Number(message.sourceSequence)) ? { sourceSeq: Number(message.sourceSequence) } : {}),
  }
}

/**
 * Project the durable UI timeline into the thread/read turn shape.
 *
 * DSH's model surface may replace old events after compaction, but
 * thread/read is a transcript API, just like Codex's thread/turns/list. The
 * normal turn items are already built from the durable events above; this
 * second pass adds timeline-only rows such as compact checkpoints and DSH
 * command results as standalone completed turns. Keeping them as standalone
 * turns avoids inventing a model turn for a control-plane event.
 */
function appendTimelineOnlyTurns(threadId, turns, events) {
  const represented = new Set()
  for (const turn of turns) {
    for (const item of turn.items || []) {
      if (Number.isSafeInteger(Number(item.sourceSeq))) represented.add(Number(item.sourceSeq))
    }
  }
  const timeline = projectHistoryMessages(threadId, events, undefined, events, {
    preserveCompactedHistory: true,
  })
  const extras = timeline
    .filter(message => Number.isSafeInteger(Number(message.sourceSequence)) && !represented.has(Number(message.sourceSequence)))
    .map(message => {
      const sourceSequence = Number(message.sourceSequence)
      const turnId = `${threadId}-timeline-${sourceSequence}`
      return {
        sequence: sourceSequence,
        turn: {
          id: turnId,
          threadId,
          status: 'completed',
          items: [normalizeItem(threadItemFromHistoryMessage(message), { threadId, turnId, sourceSeq: sourceSequence })],
        },
      }
    })
  if (extras.length === 0) return turns

  const ordered = turns.map(turn => ({
    sequence: Math.min(...(turn.items || []).map(item => Number(item.sourceSeq)).filter(Number.isSafeInteger)),
    turn,
  }))
  return [...ordered, ...extras]
    .sort((left, right) => {
      const leftSequence = Number.isSafeInteger(left.sequence) ? left.sequence : Number.POSITIVE_INFINITY
      const rightSequence = Number.isSafeInteger(right.sequence) ? right.sequence : Number.POSITIVE_INFINITY
      return leftSequence - rightSequence
    })
    .map(entry => entry.turn)
}

function summaryItem(item) {
  const summary = {
    id: item.id,
    type: item.type,
    status: item.status || 'completed',
    ...(Number.isSafeInteger(Number(item.sourceSeq)) ? { sourceSeq: Number(item.sourceSeq) } : {}),
    ...(Number.isSafeInteger(Number(item.revision)) ? { revision: Number(item.revision) } : {}),
    ...(item.messageType ? { messageType: item.messageType } : {}),
    ...(item.toolName ? { toolName: item.toolName } : {}),
    ...(item.callId ? { callId: item.callId } : {}),
  }
  if (typeof item.text === 'string' && item.text) summary.text = item.text.slice(0, 160)
  return summary
}

/** Apply Codex-shaped item loading semantics without changing durable turns. */
export function selectItemsView(turns, itemsView = 'full') {
  const view = ['notLoaded', 'summary', 'full'].includes(itemsView) ? itemsView : 'full'
  return (turns || []).map(turn => ({
    ...turn,
    itemsView: view,
    items: view === 'notLoaded'
      ? []
      : view === 'summary'
        ? (turn.items || []).map(summaryItem)
        : (turn.items || []).map(item => ({ ...item })),
  }))
}

export function projectTurns(threadId, events, fallbackMessages = [], options = undefined) {
  const turns = []
  const byNumber = new Map()
  const toolNames = new Map()
  const planSteerSequences = planSteerUserSequences(events)
  for (const event of events || []) {
    if (event.type !== 'tool/call') continue
    const callId = event.data?.callId || event.data?.id
    const name = event.data?.name || event.data?.toolName
    if (callId && name) toolNames.set(String(callId), String(name))
  }
  let current
  for (const event of events || []) {
    const number = event.data?.turn
    if (event.type === 'turn/start') {
      current = { id: stableTurnId(threadId, number ?? event.seq), threadId, status: 'inProgress', items: [], sourceTurn: number }
      turns.push(current)
      if (number != null) byNumber.set(number, current)
      continue
    }
    const target = number != null ? byNumber.get(number) || current : current
    // `/plan <prompt>` has already been represented by its durable command
    // row. The matching user/message is the model-facing steer payload and
    // must not become a second transcript item.
    if (event.type === 'user/message' && planSteerSequences.has(eventSequence(event))) continue
    const rawItem = itemFromEvent(threadId, event, toolNames)
    const item = rawItem && target
      ? normalizeItem(rawItem, { threadId, turnId: target.id, sourceSeq: event.seq, event })
      : rawItem
    if (item && target) {
      const previous = target.items.findIndex(existing => existing.id === item.id)
      if (previous >= 0) target.items[previous] = { ...target.items[previous], ...item }
      else target.items.push(item)
    }
    if (event.type === 'turn/end' && target) {
      target.status = turnEndStatus(event.data)
      const failure = turnEndError(event.data)
      if (failure) {
        target.items.push({
          id: `${threadId}-turn-${number ?? event.seq}-error`,
          type: 'agentMessage',
          text: failure.message,
          sourceSeq: event.seq,
          status: 'completed',
          errorDetails: failure.details,
        })
      }
      current = undefined
    }
  }
  if (turns.length) {
    const projected = turns.map(({ sourceTurn: _sourceTurn, ...turn }) => turn)
    const result = options?.preserveCompactedHistory
      ? appendTimelineOnlyTurns(threadId, projected, events)
      : projected
    return selectItemsView(result, options?.itemsView || 'full')
  }
  if (options?.preserveCompactedHistory) {
    const timelineTurns = appendTimelineOnlyTurns(threadId, [], events)
    if (timelineTurns.length) return selectItemsView(timelineTurns, options?.itemsView || 'full')
  }
  if (!fallbackMessages.length) return []
  return selectItemsView([{
    id: `${threadId}-turn-history`, threadId, status: 'completed',
    items: fallbackMessages.map((message, index) => ({
      id: `item-${threadId}-${index}`,
      type: message.role === 'user' ? 'userMessage' : 'agentMessage',
      text: textOf(message), sourceSeq: index, status: 'completed',
    })),
  }], options?.itemsView || 'full')
}

export { projectNotifications } from './notification-projector.js'

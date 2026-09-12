import { describe, expect, it } from 'vitest'
import { NativeDshAdapter } from '../src/app-server/adapters/native-dsh-adapter.js'

describe('NativeDshAdapter thread launch', () => {
  it('reuses the live runtime when the agent registry lookup is temporarily empty', async () => {
    let resumes = 0
    const agent = { session: { id: 'session-1', events: [], header: {} } }
    const handle = { agent, dispose: async () => {} }
    const adapter = new NativeDshAdapter({
      on: () => () => {},
      agents: {
        create: async () => handle,
        resume: async () => { resumes += 1; return handle },
        get: () => undefined,
      },
    })

    await adapter.startThread('session-1')
    await expect(adapter.resolveAgent('session-1')).resolves.toBe(agent)
    expect(resumes).toBe(0)
  })

  it('single-flights concurrent cold session recovery', async () => {
    let resumes = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const agent = { session: { id: 'session-1', events: [], header: {} } }
    const handle = { agent, dispose: async () => {} }
    const adapter = new NativeDshAdapter({
      on: () => () => {},
      agents: {
        resume: async () => {
          resumes += 1
          await gate
          return handle
        },
        create: async () => handle,
        get: () => undefined,
      },
    })

    const first = adapter.resolveAgent('session-1')
    const second = adapter.resolveAgent('session-1')
    release?.()
    await expect(Promise.all([first, second])).resolves.toEqual([agent, agent])
    expect(resumes).toBe(1)
  })

  it('delegates archive to DSH workspace-controller', async () => {
    const calls: unknown[] = []
    const adapter = new NativeDshAdapter({
      get: (name: string) => name === 'workspaceController'
        ? { archiveSession: async (request: unknown) => { calls.push(request); return { archivedSessionIds: ['session-1'] } } }
        : undefined,
    })

    await expect(adapter.archiveThread('session-1')).resolves.toEqual({ archived: true })
    expect(calls).toEqual([{ sessionId: 'session-1' }])
  })

  it('publishes durable goal changes without treating them as model items', () => {
    let sessionEvent: ((session: any, event: any) => void) | undefined
    const adapter = new NativeDshAdapter({
      on: (name: string, listener: (session: any, event: any) => void) => {
        if (name === 'session/event') sessionEvent = listener
        return () => {}
      },
    })
    const notifications: any[] = []
    adapter.subscribe(event => notifications.push(event))

    sessionEvent?.(
      { id: 'session-1', events: [] },
      { type: 'goal/change', seq: 4, data: { kind: 'goal/change', operation: 'pause' } },
    )

    expect(notifications).toEqual([expect.objectContaining({
      method: 'goal/changed',
      params: { threadId: 'session-1', sourceSeq: 4, change: { kind: 'goal/change', operation: 'pause' } },
    })])
  })

  it('forwards DSH transient assistant stream frames and reconciles the final snapshot', () => {
    let sessionEvent: ((session: any, event: any) => void) | undefined
    let assistantStream: ((payload: any) => void) | undefined
    const adapter = new NativeDshAdapter({
      on: (name: string, listener: any) => {
        if (name === 'session/event') sessionEvent = listener
        if (name === 'agent/assistant-stream') assistantStream = listener
        return () => {}
      },
    })
    const notifications: any[] = []
    adapter.subscribe(event => notifications.push(event))
    const agent = { session: { id: 'session-1', events: [] } }

    sessionEvent?.(agent.session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    assistantStream?.({ agent, frame: { type: 'start', attemptId: 'session-1:1', revision: 1, turn: 1, step: 1 } })
    assistantStream?.({ agent, frame: { type: 'chunk', attemptId: 'session-1:1', revision: 2, index: 0, chunk: { type: 'text-delta', index: 0, text: 'hello' } } })
    sessionEvent?.(agent.session, {
      type: 'assistant/message', seq: 3,
      data: { turn: 1, step: 1, message: { id: 'durable-a1', content: [{ type: 'text', text: 'hello' }] } },
    })
    assistantStream?.({
      agent,
      frame: { type: 'end', attemptId: 'session-1:1', revision: 3, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 } },
    })

    const delta = notifications.find(event => event.method === 'item/agentMessage/delta')
    const completed = notifications.find(event => event.method === 'item/completed')
    expect(delta).toMatchObject({ method: 'item/agentMessage/delta', params: { threadId: 'session-1', delta: 'hello' } })
    expect(completed).toMatchObject({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'hello' } } })
    expect(completed.params.item.id).toBe(delta.params.itemId)
    expect(completed.params.item.id).not.toBe('session-1-item-durable-a1')
  })

  it('coalesces legacy assistant chunks and keeps tool calls out of assistant text', () => {
    let sessionEvent: ((session: any, event: any) => void) | undefined
    const adapter = new NativeDshAdapter({
      on: (name: string, listener: any) => {
        if (name === 'session/event') sessionEvent = listener
        return () => {}
      },
    })
    const notifications: any[] = []
    adapter.subscribe(event => notifications.push(event))
    const session = { id: 'session-legacy', events: [] }

    sessionEvent?.(session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    sessionEvent?.(session, { type: 'assistant/chunk', seq: 2, data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '这' } } })
    sessionEvent?.(session, { type: 'assistant/chunk', seq: 3, data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: ' 4 个就是' } } })
    sessionEvent?.(session, {
      type: 'assistant/message',
      seq: 4,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-1',
          content: [
            { type: 'text', text: '这 4 个就是版本 bump 到 1.3.4。' },
            { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
          ],
        },
      },
    })

    const deltas = notifications.filter(event => event.method === 'item/agentMessage/delta')
    expect(deltas).toHaveLength(2)
    expect(deltas[0].params.itemId).toBe(deltas[1].params.itemId)
    const completed = notifications.find(event => event.method === 'item/completed')
    expect(completed.params.item).toMatchObject({
      type: 'agentMessage',
      text: '这 4 个就是版本 bump 到 1.3.4。',
    })
    expect(completed.params.item.text).not.toContain('tool-call')
    expect(completed.params.item.text).not.toContain('call-1')
    expect(completed.params.item.id).toBe(deltas[0].params.itemId)
  })

  it('admits turn image uploads before steering them into the DSH message', async () => {
    let submitted: any
    const agent = {
      session: { id: 'session-1', events: [] },
      followup: () => undefined,
      steer: (message: unknown) => { submitted = message },
    }
    const admitted = [
      { type: 'text', text: 'inspect this' },
      { type: 'image', attachment: { attachmentId: 'sha256:1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
    ]
    const adapter = new NativeDshAdapter({
      on: () => () => {},
      agents: { get: () => agent },
      get: (name: string) => name === 'attachments'
        ? { admitPromptContent: async (parts: unknown[]) => { expect(parts).toHaveLength(2); return admitted } }
        : undefined,
    })

    await expect(adapter.steerTurn('session-1', {
      text: 'inspect this',
      attachments: [{ type: 'image', mediaType: 'image/png', data: 'iVBORw==', name: 'one.png' }],
    }, 'client-message-1')).resolves.toBe(true)
    expect(submitted).toMatchObject({ id: 'client-message-1', content: admitted })
  })

  it('passes command attachments to DSH command admission', async () => {
    let submitted: unknown
    const agent = { session: { id: 'session-1', events: [] } }
    const adapter = new NativeDshAdapter({
      on: () => () => {},
      agents: { get: () => agent },
      commands: {
        execute: async (_agent: unknown, line: string, attachments: unknown[]) => {
          submitted = { line, attachments }
          return { commandId: 'cmd-1', result: { kind: 'success', text: 'ok' } }
        },
      },
    })

    await expect(adapter.executeCommand('session-1', '/goal inspect', [
      { type: 'image', mediaType: 'image/png', data: 'iVBORw==' },
    ] as any)).resolves.toMatchObject({ execution: { result: { kind: 'success' } } })
    expect(submitted).toEqual({
      line: '/goal inspect',
      attachments: [{ type: 'image', mediaType: 'image/png', data: 'iVBORw==' }],
    })
  })

  it('reports native command effects without turning commands into prompts', async () => {
    const agent = { session: { id: 'session-1', events: [] } }
    const adapter = new NativeDshAdapter({
      on: () => () => {},
      agents: { get: () => agent },
      commands: { execute: async () => ({ result: { kind: 'success', text: 'ok' } }) },
    })

    await expect(adapter.executeCommand('session-1', '/compact')).resolves.toMatchObject({ effects: { turn: 'none' } })
    await expect(adapter.executeCommand('session-1', '/plan inspect')).resolves.toMatchObject({ effects: { turn: 'steer' } })
    await expect(adapter.executeCommand('session-1', '/goal ship it')).resolves.toMatchObject({ effects: { turn: 'goal-round' } })
    await expect(adapter.executeCommand('session-1', '/goal resume')).resolves.toMatchObject({ effects: { turn: 'goal-round' } })
    await expect(adapter.executeCommand('session-1', '/plan off')).resolves.toMatchObject({ effects: { turn: 'none' } })
  })

  it('returns the grouped plugin catalog shape expected by Flowix', () => {
    const adapter = new NativeDshAdapter({
      get: (name: string) => name === 'plugins' ? { list: () => ['dsh-appserver'] } : undefined,
    })

    expect(adapter.listPlugins()).toEqual({
      plugins: {
        platform: process.platform,
        host: [{
          key: 'host:0:dsh-appserver', id: 'dsh-appserver', name: 'dsh-appserver',
          enabled: true, toggleable: false, scope: 'host',
        }],
        presets: {},
        profile: [],
      },
    })
  })

  it('reads plugins from the Cordis registry when no plugin service is exposed', () => {
    const adapter = new NativeDshAdapter({
      registry: { values: () => [{ name: 'dsh-appserver' }] },
    })

    expect(adapter.listPlugins().plugins.host.map((plugin: { id: string }) => plugin.id)).toEqual(['dsh-appserver'])
  })

  it('uses the loader inventory instead of Cordis runtime records', () => {
    const adapter = new NativeDshAdapter({
      get: (name: string) => name === 'pluginInventory'
        ? { list: () => ({ entries: [
          { entryId: 'entry-1', moduleName: '@deepseek-ai/dsh-tool-web', enabled: true, fiberPhase: 'active' },
          { entryId: 'entry-2', moduleName: '@deepseek-ai/dsh-tool-fs', enabled: false, fiberPhase: null },
        ] }) }
        : name === 'plugins'
          ? { list: () => [{ callback: () => {}, fibers: [] }] }
        : undefined,
    })

    expect(adapter.listPlugins().plugins.host).toEqual([
      {
        key: 'host:0:entry-1', id: '@deepseek-ai/dsh-tool-web', name: '@deepseek-ai/dsh-tool-web',
        enabled: true, toggleable: false, scope: 'host',
      },
      {
        key: 'host:1:entry-2', id: '@deepseek-ai/dsh-tool-fs', name: '@deepseek-ai/dsh-tool-fs',
        enabled: false, toggleable: false, scope: 'host',
      },
    ])
  })

  it('projects configured loader rows and omits Cordis groups', () => {
    const adapter = new NativeDshAdapter({
      loader: {
        entries: () => [
          { options: { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' }, disabled: false },
          { options: { id: 'tools', name: 'cordis:group', group: true }, disabled: false },
          { options: { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }, disabled: true },
        ],
      },
    })

    expect(adapter.listPlugins().plugins.host).toEqual([
      {
        key: 'host:0:tool-web', id: 'tool-web', name: '@deepseek-ai/dsh-tool-web',
        enabled: true, toggleable: false, scope: 'host',
      },
      {
        key: 'host:1:tool-fs', id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs',
        enabled: false, toggleable: false, scope: 'host',
      },
    ])
  })

  it('forks after the assistant message only after closing its turn', async () => {
    const sourceEvents = [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { id: 'u1', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant/message', seq: 3, data: { message: { id: 'a1', content: [{ type: 'text', text: 'hi' }] } } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 5, data: { turn: 2 } },
    ]
    let seed: unknown[] | undefined
    const childAgent = { session: { id: 'child', events: [], header: {}, deriveMessages: () => [] } }
    const ctx = {
      on: () => () => {},
      sessions: { get: (id: string) => id === 'source' ? { id, events: sourceEvents, header: {} } : undefined },
      agents: {
        create: async (options: Record<string, unknown>) => {
          seed = options.seed as unknown[]
          return { agent: childAgent, dispose: async () => {} }
        },
        get: () => undefined,
      },
    }
    const adapter = new NativeDshAdapter(ctx)

    await adapter.forkThread('source', 3, 'child')

    expect(seed?.map(event => (event as { seq: number }).seq)).toEqual([1, 2, 3, 4])
  })

  it('forks from persistence when the live session view has no events array', async () => {
    const events = [
      { type: 'turn/start', seq: 10, data: { turn: 1 } },
      { type: 'user/message', seq: 11, data: { id: 'u1', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant/message', seq: 12, data: { message: { id: 'a1', content: [{ type: 'text', text: 'hi' }] } } },
      { type: 'turn/end', seq: 13, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    let seed: unknown[] | undefined
    const source = { id: 'source', seq: 14, header: {} }
    const childAgent = { session: { id: 'child', events: [], header: {}, deriveMessages: () => [] } }
    const ctx = {
      on: () => () => {},
      sessions: { get: (id: string) => id === 'source' ? source : undefined },
      agents: {
        create: async (options: Record<string, unknown>) => {
          seed = options.seed as unknown[]
          return { agent: childAgent, dispose: async () => {} }
        },
        get: () => undefined,
      },
      get: (name: string) => name === 'sessionPersistence'
        ? { inspect: async () => ({ header: { cwd: '/workspace', agentPreset: 'standard' }, events }) }
        : undefined,
    }
    const adapter = new NativeDshAdapter(ctx)

    await adapter.forkThread('source', 12, 'child')

    expect(seed?.map(event => (event as { seq: number }).seq)).toEqual([10, 11, 12, 13])
  })

  it('creates a configured agent with its preset and permission', async () => {
    let options: Record<string, any> | undefined
    const mounted: string[] = []
    const permissions: string[] = []
    const agent = {
      status: 'idle',
      session: { id: 'thread-1', events: [], header: {}, deriveMessages: () => [] },
    }
    const ctx = {
      on: () => () => {},
      agents: {
        create: async (value: Record<string, any>) => {
          options = value
          return { agent, dispose: async () => {} }
        },
        get: () => undefined,
      },
      get: (name: string) => {
        if (name === 'agentPresets') return { mount: async (_ctx: unknown, preset: string) => { mounted.push(preset) } }
        if (name === 'permissionPresets') return { set: (_session: unknown, preset: string) => { permissions.push(preset) } }
        return undefined
      },
    }
    const adapter = new NativeDshAdapter(ctx)

    await adapter.startThread('thread-1', {
      cwd: '/workspace', workspacePaths: ['/workspace', '/notes'],
      provider: 'deepseek', model: 'deepseek-chat', maxTokens: 4096,
      agentPreset: 'standard', permissionMode: 'workspace-write',
    })

    expect(options?.sessionId).toBe('thread-1')
    expect(options?.meta).toEqual({ cwd: '/workspace', agentPreset: 'standard', workspacePaths: ['/workspace', '/notes'] })
    expect(options?.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat', maxTokens: 4096 })
    await options?.setup({})
    expect(mounted).toEqual(['standard'])
    expect(permissions).toEqual(['workspace-write'])
  })

  it('projects real persisted DSH messages and usage', async () => {
    const events = [
      { type: 'request/context', seq: 1, time: 100, data: { provider: 'minimax-cn', model: 'MiniMax-M3', contextWindow: 1000000 } },
      { type: 'user/message', seq: 2, time: 101, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant/chunk', seq: 3, time: 102, data: { chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 11 } } } },
      { type: 'assistant/message', seq: 4, time: 103, data: { message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 11 } } },
    ]
    const ctx = {
      on: () => () => {},
      agents: { get: () => undefined },
      sessions: { get: () => undefined },
      get: (name: string) => name === 'sessionPersistence' ? { inspect: async () => ({ events }) } : undefined,
    }
    const adapter = new NativeDshAdapter(ctx)
    await expect(adapter.sessionHistory('session-1')).resolves.toMatchObject({
      sessionId: 'session-1',
      messages: [
        expect.objectContaining({ id: 'u1', role: 'user', content: 'hello', sourceSeq: 2 }),
        expect.objectContaining({ id: 'a1', role: 'assistant', content: 'hi', sourceSeq: 4 }),
      ],
      snapshotSequence: 4,
    })
    await expect(adapter.sessionUsage('session-1')).resolves.toEqual({
      sessionId: 'session-1', modelId: 'MiniMax-M3', inputTokens: 7, outputTokens: 3,
      cacheReadTokens: 11, cacheWriteTokens: 0, contextTokens: null, contextWindow: 1000000,
    })
  })

  it('reads history through the current DSH persistence handle API', async () => {
    const events = [
      { type: 'user/message', seq: 1, data: { id: 'u1', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant/message', seq: 2, data: { message: { id: 'a1', content: [{ type: 'text', text: 'hi' }] } } },
    ]
    let closed = false
    const ctx = {
      on: () => () => {},
      agents: { get: () => undefined },
      sessions: { get: () => undefined },
      get: (name: string) => name === 'sessionPersistence' ? {
        open: async () => ({
          header: { id: 'session-1' },
          read: async () => ({ eventState: 'committed', events }),
          close: async () => { closed = true },
        }),
      } : undefined,
    }
    const adapter = new NativeDshAdapter(ctx)

    await expect(adapter.sessionHistory('session-1')).resolves.toMatchObject({
      messages: [
        expect.objectContaining({ id: 'u1', content: 'hello' }),
        expect.objectContaining({ id: 'a1', content: 'hi' }),
      ],
    })
    expect(closed).toBe(true)
  })

  it('reads token and context usage from DSH projection snapshots', async () => {
    let disposed = false
    const ctx = {
      on: () => () => {},
      agents: { get: () => undefined },
      sessions: { get: () => undefined },
      get: (name: string) => name === 'sessionQuery' ? {
        observeSession: async () => ({
          header: { id: 'session-1' },
          events: [{ type: 'request/context', data: { model: 'MiniMax-M3' } }],
          projections: {
            values: {
              tokenUsage: {
                totals: { uncachedInputTokens: 5183, outputTokens: 636, cacheReadTokens: 100864, cacheWriteTokens: 0 },
              },
              contextPressure: { projectedTokens: 13125, contextWindow: 1048576 },
              contextBreakdown: { systemTokens: 1102, toolsTokens: 7379, messageTokens: 1144 },
            },
          },
          [Symbol.dispose]: () => { disposed = true },
        }),
      } : undefined,
    }
    const adapter = new NativeDshAdapter(ctx)

    await expect(adapter.sessionUsage('session-1')).resolves.toEqual({
      sessionId: 'session-1', modelId: 'MiniMax-M3', inputTokens: 5183, outputTokens: 636,
      cacheReadTokens: 100864, cacheWriteTokens: 0, contextTokens: 13125, contextWindow: 1048576,
    })
    expect(disposed).toBe(true)
  })

  it('copies live session events when creating a history snapshot', async () => {
    const events = [{ type: 'user/message', seq: 1, data: { id: 'u1' } }]
    const adapter = new NativeDshAdapter({
      on: () => () => {},
      agents: { get: () => undefined },
      sessions: { get: (id: string) => id === 'session-1' ? { events } : undefined },
    })

    const snapshot = await adapter.eventSnapshot('session-1')
    events.push({ type: 'assistant/message', seq: 2, data: { message: { id: 'a1' } } })

    expect(snapshot.events).toHaveLength(1)
    expect(snapshot.events).not.toBe(events)
  })

  it('includes standalone command lifecycle events in session history', async () => {
    const events = [
      { type: 'command/run', seq: 1, data: {
        commandId: 'cmd-1', name: 'goal', args: ' hello', source: { kind: 'user' },
      } },
      { type: 'command/done', seq: 2, data: {
        commandId: 'cmd-1', kind: 'success', text: 'Goal created',
      } },
    ]
    const adapter = new NativeDshAdapter({
      on: () => () => {},
      agents: { get: () => undefined },
      sessions: { get: () => undefined },
      get: (name: string) => name === 'sessionPersistence'
        ? { inspect: async () => ({ events }) }
        : undefined,
    })

    await expect(adapter.sessionHistory('session-1')).resolves.toMatchObject({
      messages: [
        expect.objectContaining({ id: 'dsh-command:cmd-1:input', messageType: 'dsh-command', content: '/goal hello' }),
        expect.objectContaining({ id: 'dsh-command:cmd-1:result', messageType: 'dsh-command-result', content: 'Goal created' }),
      ],
      oldestSequence: 1,
      snapshotSequence: 2,
      hasMore: false,
    })
  })

  it('keeps command events that precede the first turn on the oldest history page', async () => {
    const events = [
      { type: 'request/context', seq: 0, data: { provider: 'deepseek' } },
      { type: 'command/run', seq: 1, data: {
        commandId: 'cmd-prefix', name: 'goal', args: ' first task', source: { kind: 'user' },
      } },
      { type: 'command/done', seq: 2, data: {
        commandId: 'cmd-prefix', kind: 'success', text: 'Goal created',
      } },
      { type: 'turn/start', seq: 3, data: { turn: 1 } },
      { type: 'user/message', seq: 4, data: { id: 'u1', content: [{ type: 'text', text: 'first task' }] } },
      { type: 'assistant/message', seq: 5, data: { message: { id: 'a1', content: [{ type: 'text', text: 'working' }] } } },
      { type: 'turn/end', seq: 6, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const adapter = new NativeDshAdapter({
      on: () => () => {},
      agents: { get: () => undefined },
      sessions: { get: () => undefined },
      get: (name: string) => name === 'sessionPersistence'
        ? { inspect: async () => ({ events }) }
        : undefined,
    })

    await expect(adapter.sessionHistory('session-1', { limit: 1 })).resolves.toMatchObject({
      messages: [
        expect.objectContaining({ id: 'dsh-command:cmd-prefix:input' }),
        expect.objectContaining({ id: 'dsh-command:cmd-prefix:result' }),
        expect.objectContaining({ id: 'u1' }),
        expect.objectContaining({ id: 'a1' }),
      ],
      oldestSequence: 1,
      hasMore: false,
    })
  })

  it('keeps a compact checkpoint next to the first turn after compaction', async () => {
    const events = [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { id: 'u1', content: [{ type: 'text', text: 'old task' }] } },
      { type: 'assistant/message', seq: 3, data: { message: { id: 'a1', content: [{ type: 'text', text: 'old answer' }] } } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
      {
        type: 'user/message', seq: 5,
        data: {
          id: 'checkpoint-1',
          content: [{ type: 'text', text: '<compacted-summary>keep this context</compacted-summary>' }],
          source: { kind: 'plugin', plugin: 'compact' },
        },
        surfaceOp: { op: 'replace', start: 1, end: 4 },
      },
      { type: 'turn/start', seq: 6, data: { turn: 2 } },
      { type: 'user/message', seq: 7, data: { id: 'u2', content: [{ type: 'text', text: 'new task' }] } },
      { type: 'assistant/message', seq: 8, data: { message: { id: 'a2', content: [{ type: 'text', text: 'new answer' }] } } },
      { type: 'turn/end', seq: 9, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    const adapter = new NativeDshAdapter({
      on: () => () => {},
      agents: { get: () => undefined },
      sessions: { get: () => undefined },
      get: (name: string) => name === 'sessionPersistence'
        ? { inspect: async () => ({ events }) }
        : undefined,
    })

    await expect(adapter.sessionHistory('session-1', { limit: 1 })).resolves.toMatchObject({
      messages: [
        expect.objectContaining({ id: 'checkpoint-1', messageType: 'context-compaction' }),
        expect.objectContaining({ id: 'u2' }),
        expect.objectContaining({ id: 'a2' }),
      ],
      oldestSequence: 5,
      hasMore: true,
    })
  })

  it('prefers the event log handle when metadata inspection is also available', async () => {
    const events = [
      { type: 'user/message', seq: 1, data: { id: 'u1', content: [{ type: 'text', text: 'from event log' }] } },
      { type: 'assistant/message', seq: 2, data: { message: { id: 'a1', content: [{ type: 'text', text: 'reply' }] } } },
    ]
    let inspected = false
    let opened = false
    const adapter = new NativeDshAdapter({
      on: () => () => {},
      agents: { get: () => undefined },
      sessions: { get: () => undefined },
      get: (name: string) => name === 'sessionPersistence' ? {
        // Current DSH's metadata observation API must not be used as history.
        inspect: async () => { inspected = true; return { header: { id: 'session-1' }, rows: {} } },
        open: async () => {
          opened = true
          return { read: async () => events, close: async () => {} }
        },
      } : undefined,
    })

    await expect(adapter.sessionHistory('session-1')).resolves.toMatchObject({
      messages: [
        expect.objectContaining({ id: 'u1', content: 'from event log' }),
        expect.objectContaining({ id: 'a1', content: 'reply' }),
      ],
    })
    expect(opened).toBe(true)
    expect(inspected).toBe(false)
  })

  it('uses the current persistence handle for thread/read after restart', async () => {
    const events = [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { id: 'u1', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant/message', seq: 3, data: { message: { id: 'a1', content: [{ type: 'text', text: 'hi' }] } } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const adapter = new NativeDshAdapter({
      on: () => () => {},
      agents: { get: () => undefined },
      sessions: { get: () => undefined },
      get: (name: string) => name === 'sessionPersistence' ? {
        open: async () => ({
          header: { id: 'session-1', parentSession: 'parent-1' },
          read: async () => events,
          close: async () => {},
        }),
      } : undefined,
    })

    await expect(adapter.readThread('session-1')).resolves.toMatchObject({
      id: 'session-1',
      parentThreadId: 'parent-1',
      turns: [expect.objectContaining({ items: expect.any(Array) })],
    })
  })

  it('returns the full transcript and compact checkpoint from thread/read', async () => {
    const events = [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { id: 'u1', content: [{ type: 'text', text: 'old task' }] }, surfaceOp: 'append' },
      { type: 'assistant/message', seq: 3, data: { message: { id: 'a1', content: [{ type: 'text', text: 'old answer' }] } }, surfaceOp: 'append' },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'command/run', seq: 5, data: { commandId: 'cmd-compact', name: 'compact', args: '', source: { kind: 'user' } } },
      {
        type: 'user/message', seq: 6,
        data: {
          id: 'checkpoint-1',
          content: [{ type: 'text', text: '<compacted-summary>internal summary</compacted-summary>' }],
          source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact-1', sourceCommandId: 'cmd-compact' },
        },
        surfaceOp: { op: 'replace', start: 1, end: 4 },
      },
      { type: 'command/done', seq: 7, data: { commandId: 'cmd-compact', kind: 'success', text: 'Compacted 2 history items (~12 tokens).' } },
    ]
    const adapter = new NativeDshAdapter({
      on: () => () => {},
      agents: { get: () => undefined },
      sessions: { get: () => undefined },
      get: (name: string) => name === 'sessionPersistence'
        ? { inspect: async () => ({ events }) }
        : undefined,
    })

    const result = await adapter.readThread('session-1')
    const items = result.turns.flatMap((turn: any) => turn.items)
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'session-1-item-u1', type: 'userMessage', text: 'old task' }),
      expect.objectContaining({ id: 'session-1-item-3', type: 'agentMessage', text: 'old answer' }),
      expect.objectContaining({
        id: 'checkpoint-1',
        type: 'systemMessage',
        messageType: 'context-compaction',
        text: 'Compacted 2 history items (~12 tokens).',
      }),
    ]))
  })

  it('returns one readable tool message for persisted call and result events', async () => {
    const events = [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { id: 'u1', content: [{ type: 'text', text: 'inspect' }] } },
      { type: 'tool/call', seq: 3, data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"file_path":"a.txt"}' } },
      { type: 'tool/result', seq: 4, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'alpha' }] }], role: 'user', id: 'r1' } } },
    ]
    const adapter = new NativeDshAdapter({
      on: () => () => {}, agents: { get: () => undefined }, sessions: { get: () => undefined },
      get: (name: string) => name === 'sessionPersistence' ? { inspect: async () => ({ events }) } : undefined,
    })

    const result = await adapter.sessionHistory('session-1')
    expect(result.messages.filter(message => message.role === 'tool')).toHaveLength(1)
    expect(result.messages[1]).toMatchObject({
      id: 'call-1', content: 'alpha', toolData: 'alpha',
      toolInput: { file_path: 'a.txt' }, isCompleted: true,
    })
  })

  it('pages history by complete turns instead of projected message count', async () => {
    const events = []
    for (let turn = 1; turn <= 12; turn++) {
      const base = turn * 10
      events.push(
        { type: 'turn/start', seq: base, data: { turn } },
        { type: 'user/message', seq: base + 1, data: { id: `u${turn}`, content: [{ type: 'text', text: `q${turn}` }] } },
        { type: 'tool/call', seq: base + 2, data: { turn, callId: `call-${turn}`, name: 'read', arguments: '{}' } },
        { type: 'tool/result', seq: base + 3, data: { turn, callId: `call-${turn}`, result: `r${turn}` } },
        { type: 'assistant/message', seq: base + 4, data: { message: { id: `a${turn}`, content: [{ type: 'text', text: `a${turn}` }] } } },
        { type: 'turn/end', seq: base + 5, data: { turn, reason: { kind: 'completed' } } },
      )
    }
    const adapter = new NativeDshAdapter({
      on: () => () => {}, agents: { get: () => undefined }, sessions: { get: () => undefined },
      get: (name: string) => name === 'sessionPersistence' ? { inspect: async () => ({ events }) } : undefined,
    })

    const first = await adapter.sessionHistory('session-1', { limit: 10 })
    expect(first.hasMore).toBe(true)
    expect(first.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(
      Array.from({ length: 10 }, (_, index) => `q${index + 3}`),
    )
    expect(first.oldestSequence).toBe(30)

    const second = await adapter.sessionHistory('session-1', {
      beforeSequence: first.oldestSequence,
      snapshotSequence: first.snapshotSequence,
      limit: 10,
    })
    expect(second.hasMore).toBe(false)
    expect(second.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['q1', 'q2'])
    expect(second.messages.some(message => message.content === 'q3')).toBe(false)
  })

  it('steers into the active DSH next-step inbox without starting a turn', async () => {
    let steered: any
    const agent = {
      session: { id: 'session-1', events: [], header: {}, deriveMessages: () => [] },
      status: 'running',
      steer: (message: any) => { steered = message },
    }
    const adapter = new NativeDshAdapter({
      on: () => () => {},
      agents: { get: (id: string) => id === 'session-1' ? agent : undefined },
    })

    await expect(adapter.steerTurn('session-1', 'continue with the next step', 'flowix-steer-1')).resolves.toBe(true)
    expect(steered).toMatchObject({
      id: 'flowix-steer-1', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'continue with the next step' }],
    })
  })

})

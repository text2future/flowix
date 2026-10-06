import { describe, expect, it } from 'vitest'
import { AppServer, InMemoryHarnessAdapter } from '../src/index.js'

describe('dsh-appserver protocol', () => {
  it('negotiates the App Server protocol version during initialize', async () => {
    const server = new AppServer(null, { adapter: new InMemoryHarnessAdapter() })
    const initialized = await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })
    expect(initialized.result?.protocolVersion).toBe(1)
    expect(initialized.result?.apiVersion).toBe('v2')
    expect(initialized.result?.features?.capabilityNegotiation).toBe(true)
    expect(initialized.result?.limits?.maxEventList).toBe(1000)

    const incompatible = new AppServer(null, { adapter: new InMemoryHarnessAdapter() })
    const result = await incompatible.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 2 } })
    expect(result.error?.code).toBe(-32602)
  })

  it('exposes the same protocol descriptor through runtime status', async () => {
    const server = new AppServer(null, { adapter: new InMemoryHarnessAdapter() })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    const result = await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'runtime/status' })
    expect(result.result?.protocolVersion).toBe(1)
    expect(result.result?.apiVersion).toBe('v2')
    expect(result.result?.features?.revisionedMutations).toBe(true)
  })

  it('requires initialize before thread operations', async () => {
    const server = new AppServer(null, { adapter: new InMemoryHarnessAdapter() })
    const result = await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'thread/list' })
    expect(result.error?.code).toBe(-32002)
  })

  it('supports thread start, turn, read, fork and paged turns', async () => {
    const server = new AppServer(null, { adapter: new InMemoryHarnessAdapter() })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    const started = await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: { threadId: 'flowix-local-root' } })
    const root = (started.result as { thread: { id: string } }).thread.id
    expect(root).toMatch(/^session-/)
    expect(root).not.toBe('flowix-local-root')
    await server.dispatch({ jsonrpc: '2.0', id: 3, method: 'turn/start', params: { threadId: root, input: 'hello' } })
    const fork = await server.dispatch({ jsonrpc: '2.0', id: 4, method: 'thread/fork', params: { threadId: root, newThreadId: 'child' } })
    const read = await server.dispatch({ jsonrpc: '2.0', id: 5, method: 'thread/read', params: { threadId: 'child' } })
    const page = await server.dispatch({ jsonrpc: '2.0', id: 6, method: 'thread/turns/list', params: { threadId: root, limit: 1 } })
    expect(fork.error).toBeUndefined()
    expect((read.result as { thread: { parentThreadId?: string } }).thread.parentThreadId).toBe(root)
    expect((page.result as { page: { data: unknown[] } }).page.data).toHaveLength(1)
    const compactPage = await server.dispatch({ jsonrpc: '2.0', id: 7, method: 'thread/turns/list', params: { threadId: root, limit: 1, itemsView: 'notLoaded' } })
    expect((compactPage.result as { page: { data: Array<{ itemsView?: string; items: unknown[] }> } }).page.data[0]).toMatchObject({ itemsView: 'notLoaded', items: [] })
  })

  it('supports provider-backed thread archive', async () => {
    const server = new AppServer(null, { adapter: new InMemoryHarnessAdapter() })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    const started = await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'thread/start' })
    const threadId = (started.result as { thread: { id: string } }).thread.id
    const archived = await server.dispatch({ jsonrpc: '2.0', id: 3, method: 'thread/archive', params: { threadId } })
    expect(archived.error).toBeUndefined()
    expect(archived.result).toEqual({ archived: true })
  })

  it('exposes durable goal get/set/clear operations with optimistic revisions', async () => {
    const events: any[] = [{
      type: 'goal/change', seq: 1,
      data: { kind: 'goal/change', version: 1, operation: 'set', goal: { id: 'goal-1', revision: 1, objective: 'old objective', phase: 'active' } },
    }]
    const commands: string[] = []
    const adapter = {
      subscribe: () => () => {},
      listEvents: async (_threadId: string, afterSeq = -1) => ({
        data: events.filter(event => event.seq > afterSeq), nextCursor: null,
      }),
      executeCommand: async (_threadId: string, command: string) => {
        commands.push(command)
        if (command.startsWith('/goal set ')) events.push({
          type: 'goal/change', seq: events.length + 1,
          data: { kind: 'goal/change', version: 2, operation: 'set', goal: { id: 'goal-1', revision: 2, objective: command.slice('/goal set '.length), phase: 'active' } },
        })
        if (command === '/goal clear') events.push({ type: 'goal/change', seq: events.length + 1, data: { kind: 'goal/change', operation: 'clear', goalId: 'goal-1' } })
        return { execution: { result: { kind: 'success' } } }
      },
    }
    const server = new AppServer(null, { adapter })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    const before = await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'thread/goal/get', params: { threadId: 'thread-1' } })
    expect(before.result?.goal).toMatchObject({ id: 'goal-1', version: 1, objective: 'old objective', status: 'active' })
    const updated = await server.dispatch({ jsonrpc: '2.0', id: 3, method: 'thread/goal/set', params: { threadId: 'thread-1', objective: 'new objective', expectedVersion: 1 } })
    expect(updated.result?.goal).toMatchObject({ version: 2, objective: 'new objective' })
    expect(commands).toEqual(['/goal set new objective'])
    const conflict = await server.dispatch({ jsonrpc: '2.0', id: 4, method: 'thread/goal/set', params: { threadId: 'thread-1', objective: 'stale', expectedVersion: 1 } })
    expect(conflict.error?.data).toMatchObject({ kind: 'revision_conflict', expected: 1, actual: 2 })
    const cleared = await server.dispatch({ jsonrpc: '2.0', id: 5, method: 'thread/goal/clear', params: { threadId: 'thread-1', expectedVersion: 2 } })
    expect(cleared.result).toEqual({ cleared: true, goal: null })
  })

  it('forwards turn and command attachments without turning them into paths', async () => {
    const calls: unknown[] = []
    const adapter = {
      subscribe: () => () => {},
      startThread: async (threadId: string) => ({ id: threadId, status: 'idle', turns: [] }),
      startTurn: async (_threadId: string, input: unknown) => { calls.push({ kind: 'turn', input }); return { id: 'turn-1', threadId: 'thread-1', status: 'inProgress', items: [] } },
      executeCommand: async (_threadId: string, command: string, attachments: unknown[]) => { calls.push({ kind: 'command', command, attachments }); return { ok: true } },
    }
    const server = new AppServer(null, { adapter })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'turn/start', params: {
      threadId: 'thread-1', input: { text: 'look', attachments: [{ type: 'image', mediaType: 'image/png', data: 'AQ==' }] },
    } })
    await server.dispatch({ jsonrpc: '2.0', id: 3, method: 'thread/command', params: {
      threadId: 'thread-1', command: '/goal look', attachments: [{ type: 'image', mediaType: 'image/png', data: 'AQ==' }],
    } })
    expect(calls).toEqual([
      { kind: 'turn', input: { text: 'look', attachments: [{ type: 'image', mediaType: 'image/png', data: 'AQ==' }] } },
      { kind: 'command', command: '/goal look', attachments: [{ type: 'image', mediaType: 'image/png', data: 'AQ==' }] },
    ])
  })

  it('forwards App Server launch context when creating a thread', async () => {
    let launch: Record<string, unknown> | undefined
    const adapter = {
      subscribe: () => () => {},
      emit: () => {},
      startThread: async (_threadId: string, config: Record<string, unknown>) => {
        launch = config
        return { id: 'root', status: 'idle', turns: [] }
      },
    }
    const server = new AppServer(null, { adapter })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    const result = await server.dispatch({
      jsonrpc: '2.0', id: 2, method: 'thread/start',
      params: {
        threadId: 'root', cwd: '/workspace',
        provider: 'deepseek', model: 'deepseek-chat', maxTokens: 4096,
        agentPreset: 'standard', permissionMode: 'workspace-write',
      },
    })
    expect(result.error).toBeUndefined()
    expect(launch).toEqual({
      cwd: '/workspace',
      provider: 'deepseek', model: 'deepseek-chat', maxTokens: 4096,
      agentPreset: 'standard', permissionMode: 'workspace-write',
    })
  })

  it('rejects duplicate initialize and malformed params', async () => {
    const server = new AppServer(null, { adapter: new InMemoryHarnessAdapter() })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    const duplicate = await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'initialize' })
    const invalid = await server.dispatch({ jsonrpc: '2.0', id: 3, method: 'thread/read', params: [] })
    expect(duplicate.error?.code).toBe(-32003)
    expect(invalid.error?.code).toBe(-32602)
  })

  it('serializes one thread while allowing different threads to run concurrently', async () => {
    let active = 0
    let maxActive = 0
    const adapter = {
      subscribe: () => () => {},
      readThread: async (threadId: string) => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 20))
        active--
        return { id: threadId, status: 'idle', turns: [] }
      },
    }
    const server = new AppServer(null, { adapter })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    await Promise.all([
      server.dispatch({ jsonrpc: '2.0', id: 2, method: 'thread/read', params: { threadId: 'a' } }),
      server.dispatch({ jsonrpc: '2.0', id: 3, method: 'thread/read', params: { threadId: 'b' } }),
    ])
    expect(maxActive).toBe(2)
    maxActive = 0
    await Promise.all([
      server.dispatch({ jsonrpc: '2.0', id: 4, method: 'thread/read', params: { threadId: 'a' } }),
      server.dispatch({ jsonrpc: '2.0', id: 5, method: 'thread/read', params: { threadId: 'a' } }),
    ])
    expect(maxActive).toBe(1)
  })

  it('tracks initialize state per connection', async () => {
    const server = new AppServer(null, { adapter: new InMemoryHarnessAdapter() })
    const first = await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' }, 'client-a')
    const second = await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'initialize' }, 'client-b')
    const duplicate = await server.dispatch({ jsonrpc: '2.0', id: 3, method: 'initialize' }, 'client-a')
    expect(first.error).toBeUndefined()
    expect(second.error).toBeUndefined()
    expect(duplicate.error?.code).toBe(-32003)
  })

  it('allows a released HTTP connection identity to initialize again', async () => {
    const server = new AppServer(null, { adapter: new InMemoryHarnessAdapter() })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' }, 'mobile-a')
    server.disconnectConnection('mobile-a', 0)
    const reinitialized = await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'initialize' }, 'mobile-a')
    expect(reinitialized.error).toBeUndefined()
  })

  it('applies notification opt-out per connection', async () => {
    const listeners = new Set<(event: { method: string }) => void>()
    const adapter = { subscribe: (listener: (event: { method: string }) => void) => { listeners.add(listener); return () => listeners.delete(listener) } }
    const server = new AppServer(null, { adapter })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { optOutNotificationMethods: ['warning'] } } }, 'client-a')
    const received: string[] = []
    server.subscribeConnection('client-a', (event: { method: string }) => received.push(event.method))
    for (const listener of listeners) listener({ method: 'warning' })
    for (const listener of listeners) listener({ method: 'turn/started' })
    expect(received).toEqual(['turn/started'])
  })
})

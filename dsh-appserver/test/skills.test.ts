import { describe, expect, it } from 'vitest'
import { AppServer } from '../src/index.js'
import { SkillCatalogService } from '../src/protocol.js'

describe('skills/list protocol', () => {
  it('groups normalized metadata by cwd, isolates registry errors and caches reads', async () => {
    const calls: string[] = []
    const registry = {
      list: async ({ cwd }: { cwd: string }) => {
        calls.push(cwd)
        if (cwd === 'broken') throw new Error('plugin unavailable')
        return [
          { name: 'zeta', description: 'Z', path: `${cwd}/zeta/SKILL.md`, scope: 'repo', invocation: { modelInvocable: true } },
          { name: 'alpha', description: 'A', invocation: { userInvocable: false } },
        ]
      },
    }
    const adapter = {
      ctx: { get: (name: string) => name === 'skills' ? registry : undefined },
      subscribe: () => () => {},
    }
    const server = new AppServer(null, { adapter })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' })

    const first = await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'skills/list', params: { cwds: ['workspace', 'broken'] } })
    expect(first.result).toMatchObject({
      data: [
        { cwd: 'workspace', skills: [{ name: 'alpha' }, { name: 'zeta', scope: 'repo', path: 'workspace/zeta/SKILL.md' }], errors: [] },
        { cwd: 'broken', skills: [], errors: [{ path: 'broken', message: 'plugin unavailable' }] },
      ],
      revision: 0,
    })
    expect(calls).toEqual(['workspace', 'broken'])

    await server.dispatch({ jsonrpc: '2.0', id: 3, method: 'skills/list', params: { cwds: ['workspace', 'broken'] } })
    expect(calls).toEqual(['workspace', 'broken'])
    await server.dispatch({ jsonrpc: '2.0', id: 4, method: 'skills/list', params: { cwds: ['workspace'], forceReload: true } })
    expect(calls).toEqual(['workspace', 'broken', 'workspace'])
  })

  it('keeps thread/skills as a compact compatibility projection', async () => {
    const registry = { list: async () => [{ name: 'visible', description: 'ok', invocation: { userInvocable: true } }, { name: 'hidden', description: 'no', invocation: { userInvocable: false } }] }
    const adapter = {
      ctx: { get: (name: string) => name === 'skills' ? registry : undefined },
      subscribe: () => () => {},
      resolveAgent: async () => ({ session: { id: 'thread-1', header: { cwd: 'workspace' } } }),
    }
    const server = new AppServer(null, { adapter })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    const result = await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'thread/skills', params: { threadId: 'thread-1' } })
    expect(result.result).toEqual({ skills: [{ name: 'visible', description: 'ok', scope: 'repo' }] })
  })

  it('routes skill enablement and extra roots through the shared config port', async () => {
    const calls: any[] = []
    const catalog = new SkillCatalogService({}) as any
    catalog.configService = { writeValue: async (params: any) => { calls.push(params); return { revision: 9 } } }
    const adapter = { skillCatalog: catalog, subscribe: () => () => {} }
    const server = new AppServer(null, { adapter })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    const disabled = await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'skills/config/write', params: { selector: { name: 'reviewer' }, enabled: false, expectedRevision: 8 } })
    const roots = await server.dispatch({ jsonrpc: '2.0', id: 3, method: 'skills/extraRoots/set', params: { extraRoots: ['D:/skills'], expectedRevision: 9 } })
    expect(disabled.result).toEqual({ effectiveEnabled: false, revision: 9 })
    expect(roots.result).toEqual({ extraRoots: ['D:/skills'], revision: 9 })
    expect(calls).toEqual([
      { namespace: 'flowix-appserver', path: ['skills', 'enabled', 'reviewer'], value: false, expectedRevision: 8 },
      { namespace: 'flowix-appserver', path: ['skills', 'extraRoots'], value: ['D:/skills'], expectedRevision: 9 },
    ])
  })
})

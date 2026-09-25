import { DshAppServer } from './app-server/server.js'
import { createHttpTransport } from './app-server/transports/http.js'

export const name = 'dsh-appserver'
// Model settings/discovery are optional capabilities. Credentials and approval
// are different: the app-server advertises credential management and always
// checks approval during setup, so wait for both services before accepting the
// first JSON-RPC request. Without this dependency a just-started host can
// answer `initialize` and then race `credential/set`, yielding the misleading
// "DSH credentials service is unavailable" error.
export const inject = [
  'agents',
  'sessions',
  'sessionPersistence',
  'sessionQuery',
  'sessionProjections',
  // Wait for DSH's registry before serving the native session skill catalog.
  'skills',
  // The native continuable-subagent seam is the durable source for the
  // app-server's Codex-shaped collaboration surface. Inject it so the
  // server cannot start before DSH has mounted the authoritative registry.
  'subagents',
  'credentials',
  'approval',
  'commands',
]

export default function dshAppServer(ctx, config = {}) {
  if (!ctx.get?.('approval')) throw new Error('dsh-appserver requires the native DSH approval service')
  const logger = ctx.logger?.('dsh-appserver')
  const observer = config.observer || (config.telemetry === true && logger?.debug
    ? event => logger.debug(event)
    : undefined)
  const server = new DshAppServer(ctx, { ...config.server, observer })
  const disposeApproval = ctx.on?.('approval/request', (request, next) => server.handleApproval(request, next))
  server.addDisposer(disposeApproval)
  const http = config.http ? createHttpTransport(server, config.http) : null
  const httpReady = http?.listen()
  httpReady?.catch(error => {
    logger?.error?.(`HTTP transport failed to listen: ${error instanceof Error ? error.message : String(error)}`)
  })
  const service = {
    dispatch: (request, connectionId) => server.dispatch(request, connectionId),
    receiveResponse: (response, connectionId) => server.receiveResponse(response, connectionId),
    createConnection: connectionId => server.createConnection(connectionId),
    subscribe: listener => server.subscribe(listener),
    subscribeConnection: (connectionId, listener) => server.subscribeConnection(connectionId, listener),
    pendingServerRequests: (connectionId, threadId) => server.pendingServerRequests(connectionId, threadId),
    listEvents: (...args) => server.listEvents(...args),
    serveStdio: () => server.serveStdio(),
    listenHttp: () => httpReady,
    ready: httpReady || Promise.resolve(),
    dispose: async () => { await http?.close(); await server.dispose() }
  }
  ctx.provide('dshAppServer', service)
  // Profile configuration/environment owns the stdio switch. Do not inject
  // the CLI-only cmdlineArgs service: embedded SDK runners do not provide it.
  if (config.stdio || process.env.FLOWIX_DSH_APPSERVER_STDIO === '1') server.serveStdio()
  return () => service.dispose()
}
dshAppServer.inject = inject

export { DshAppServer, createHttpTransport }

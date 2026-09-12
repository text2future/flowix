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
  'credentials',
  'approval',
  'commands',
]

export default function dshAppServer(ctx, config = {}) {
  if (!ctx.get?.('approval')) throw new Error('dsh-appserver requires the native DSH approval service')
  const server = new DshAppServer(ctx)
  const disposeApproval = ctx.on?.('approval/request', (request, next) => server.handleApproval(request, next))
  server.addDisposer(disposeApproval)
  const http = config.http ? createHttpTransport(server, config.http) : null
  const service = {
    dispatch: (request, connectionId) => server.dispatch(request, connectionId),
    receiveResponse: (response, connectionId) => server.receiveResponse(response, connectionId),
    createConnection: connectionId => server.createConnection(connectionId),
    subscribe: listener => server.subscribe(listener),
    subscribeConnection: (connectionId, listener) => server.subscribeConnection(connectionId, listener),
    pendingServerRequests: (connectionId, threadId) => server.pendingServerRequests(connectionId, threadId),
    listEvents: (...args) => server.listEvents(...args),
    serveStdio: () => server.serveStdio(),
    listenHttp: () => http?.listen(),
    dispose: async () => { await http?.close(); await server.dispose() }
  }
  ctx.provide('dshAppServer', service)
  // Profile configuration/environment owns the stdio switch. Do not inject
  // the CLI-only cmdlineArgs service: embedded SDK runners do not provide it.
  if (config.stdio || process.env.FLOWIX_DSH_APPSERVER_STDIO === '1') server.serveStdio()
  if (http) http.listen()
  return () => service.dispose()
}
dshAppServer.inject = inject

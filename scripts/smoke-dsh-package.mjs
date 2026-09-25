import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const rootFlagIndex = process.argv.indexOf('--root')
const rootArg = rootFlagIndex >= 0 ? process.argv[rootFlagIndex + 1] : process.argv[2]
if (!rootArg) throw new Error('usage: node smoke-dsh-package.mjs --root <bundle-root>')

const root = resolve(rootArg)
const smokeTimeoutMs = Number(process.env.FLOWIX_DSH_SMOKE_TIMEOUT_MS) > 0
  ? Number(process.env.FLOWIX_DSH_SMOKE_TIMEOUT_MS)
  : 120_000
const metadata = existsSync(resolve(root, 'dsh-runtime.json'))
  ? JSON.parse(await readFile(resolve(root, 'dsh-runtime.json'), 'utf8'))
  : { runtimeType: 'node-bundle', nodeExecutable: 'node/node', entrypoint: 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js' }
if (metadata.runtimeType && metadata.runtimeType !== 'node-bundle') {
  throw new Error(`DSH package smoke only supports node-bundle, got ${metadata.runtimeType}`)
}
const nodeExecutable = resolve(root, metadata.nodeExecutable ?? 'node/node')
const entrypoint = resolve(root, metadata.entrypoint ?? 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js')
const profile = resolve(root, 'profile/flowix')
if (!existsSync(nodeExecutable) || !existsSync(entrypoint) || !existsSync(profile)) {
  throw new Error(`DSH package is incomplete: node=${nodeExecutable}, entrypoint=${entrypoint}, profile=${profile}`)
}

// Loading the native addon in the bundled Node catches a wrong-architecture or
// wrapper/native version before the JSON-RPC process is even started.
const requireFromRuntime = createRequire(resolve(root, 'runtime/node_modules/koffi/package.json'))
requireFromRuntime('koffi')

const smokeRoot = resolve(root, `.smoke-home-${randomUUID()}`)
const home = resolve(smokeRoot, 'dsh-home')
const profileHome = resolve(home, 'profiles/flowix')
await mkdir(resolve(home, 'profiles'), { recursive: true })
await cp(profile, profileHome, { recursive: true })
await writeFile(resolve(home, 'settings.yaml'), 'llm-pi-ai:\n  providers: {}\n')
await writeFile(resolve(home, '.credentials.yaml'), 'DSH_API_KEY: health-check\n', { mode: 0o600 })
const workspace = resolve(smokeRoot, 'workspace')
const skillDir = resolve(workspace, '.agents/skills/package-smoke')
await mkdir(skillDir, { recursive: true })
// DSH walks to the nearest Git root; keep this fixture inside its own project.
await mkdir(resolve(workspace, '.git'))
await writeFile(resolve(skillDir, 'SKILL.md'), '---\nname: package-smoke\ndescription: Package skill discovery check\n---\nRead the project instructions.\n')

const stderr = []
const child = spawn(nodeExecutable, [entrypoint, '--profile', 'flowix'], {
  cwd: root,
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_SETTINGS_PATH: resolve(home, 'settings.yaml'),
    DSH_CREDENTIALS_PATH: resolve(home, '.credentials.yaml'),
    DSH_PROFILE_DIR: profileHome,
    FLOWIX_DSH_ROOT: root,
    FLOWIX_DSH_APPSERVER_STDIO: '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
})
child.stderr.on('data', chunk => stderr.push(String(chunk)))
const lineReader = createInterface({ input: child.stdout })
const lines = lineReader[Symbol.asyncIterator]()

try {
  const initialized = await request(child, lines, 1, 'initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'flowix-package-smoke', version: '1' },
    capabilities: {},
  })
  const initializeResult = initialized.result
  if (initializeResult?.protocolVersion !== 1 || initializeResult?.serverInfo?.name !== 'dsh-appserver') {
    throw new Error(`initialize returned unexpected result: ${JSON.stringify(initializeResult)}`)
  }

  const thread = await request(child, lines, 2, 'thread/start', {
    flowixThreadId: 'flowix-package-smoke',
    cwd: workspace,
    workspacePaths: [],
    provider: 'openai',
    model: 'health-check-model',
    agentPreset: 'minimal',
    permissionMode: 'read-only',
  })
  const threadId = thread.result?.thread?.id
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new Error(`thread/start returned no thread id: ${JSON.stringify(thread)}`)
  }
  await checkSkills(5)
  await request(child, lines, 3, 'thread/close', { threadId })
  await checkSkills(6)
  await request(child, lines, 4, 'shutdown', {})
  console.log(`DSH package smoke passed: ${root}`)

  async function checkSkills(id) {
    const response = await request(child, lines, id, 'thread/skills', { threadId })
    if (!response.result?.skills?.some(skill => skill.name === 'package-smoke' && skill.scope === 'repo')) {
      throw new Error(`thread/skills did not discover the project skill: ${JSON.stringify(response)}`)
    }
  }
} catch (error) {
  const details = stderr.join('').trim()
  throw new Error(`${error.message}${details ? `; stderr=${details}` : ''}`)
} finally {
  lineReader.close()
  if (child.exitCode === null) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        // macOS may launch the child without a separate process group.
        // Fall back to its pid so cleanup does not turn a passed smoke test
        // into a packaging failure.
        if (error?.code !== 'EPERM') throw error
        process.kill(child.pid, 'SIGKILL')
      }
    }
    await new Promise(resolveWait => {
      if (child.exitCode !== null) resolveWait()
      else {
        child.once('exit', resolveWait)
        setTimeout(resolveWait, 2_000).unref()
      }
    })
  }
  await rm(smokeRoot, { recursive: true, force: true })
}

async function request(childProcess, iterator, id, method, params) {
  const requestBody = JSON.stringify({ jsonrpc: '2.0', id, method, params })
  childProcess.stdin.write(`${requestBody}\n`)
  const deadline = Date.now() + smokeTimeoutMs
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    let timer
    const nextPromise = iterator.next()
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${method} timed out`)), remaining)
    })
    let next
    try { next = await Promise.race([nextPromise, timeoutPromise]) } finally { clearTimeout(timer) }
    if (next.done) throw new Error(`${method} process exited before replying`)
    let frame
    try { frame = JSON.parse(next.value.trim()) } catch (_) { continue }
    if (frame.id !== id) continue
    if (frame.error) throw new Error(`${method} failed: ${frame.error.message ?? 'unknown JSON-RPC error'}`)
    return frame
  }
  throw new Error(`${method} timed out`)
}

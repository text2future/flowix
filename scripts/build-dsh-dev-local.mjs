import { copyFile, cp, lstat, mkdir, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { repairDshNativePackages, verifyDshNativePackages } from './dsh-native-deps.mjs'

if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`DSH development builds require Node 24; current runtime is ${process.version}`)
}

const repo = resolve(import.meta.dirname, '..')
await import('./ensure-dsh-upstream.mjs')

const configuredUpstream = process.env.FLOWIX_DSH_UPSTREAM_ROOT?.trim()
const upstream = configuredUpstream
  ? resolve(configuredUpstream)
  : resolve(repo, '.build/upstream/deepseek-harness')
const target = targetKey()
const bundle = resolve(repo, '.build/dsh-runtime-dev', target)
const runtime = resolve(bundle, 'runtime')
const profile = resolve(bundle, 'profile/flowix')
const pnpmVersion = '11.7.0'
const corepackCommand = process.platform === 'win32' ? process.execPath : 'corepack'
const corepackArgs = process.platform === 'win32'
  ? [resolve(dirname(process.execPath), 'node_modules/corepack/dist/corepack.js')]
  : []

process.env.CI = 'true'
process.env.NODE_ENV = 'development'

if (!existsSync(resolve(upstream, 'package.json'))) {
  throw new Error(`local DSH source is missing: ${upstream}`)
}

if (!existsSync(resolve(upstream, 'node_modules/.modules.yaml'))) {
  await run(corepackCommand, [...corepackArgs, `pnpm@${pnpmVersion}`, 'install', '--frozen-lockfile', '--prod=false'], upstream)
}

const cliMarker = resolve(upstream, 'apps/cli/lib/bin.js')
if (!existsSync(cliMarker) || process.env.FLOWIX_DSH_REBUILD_LIBS === '1') {
  await run(corepackCommand, [...corepackArgs, `pnpm@${pnpmVersion}`, 'run', 'build:lib:host'], upstream)
}

await rm(bundle, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
await mkdir(bundle, { recursive: true })
await rm(runtime, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
await run(corepackCommand, [...corepackArgs,
  `pnpm@${pnpmVersion}`, '--filter', '@deepseek-ai/dsh', 'deploy', '--legacy', '--prod',
  '--config.node-linker=hoisted', '--config.auto-install-peers=false', runtime,
], upstream)

await materializeLinks(resolve(runtime, 'node_modules'))
await materializeWorkspaceRoots(runtime, upstream)
await repairDshNativePackages(runtime, upstream)
await verifyDshNativePackages(runtime)
await rm(resolve(runtime, 'src'), { recursive: true, force: true })
await copyTree(resolve(upstream, 'apps/cli'), resolve(runtime, 'node_modules/@deepseek-ai/dsh'))
await copyTree(resolve(repo, 'dsh-appserver'), resolve(runtime, 'node_modules/dsh-appserver'), true)
await copyTree(resolve(repo, 'dsh-flowix-memory'), resolve(runtime, 'node_modules/dsh-flowix-memory'), true)

await mkdir(resolve(profile, 'node_modules'), { recursive: true })
await copyTree(resolve(repo, 'dsh-appserver'), resolve(profile, 'node_modules/dsh-appserver'), true)
await copyTree(resolve(repo, 'dsh-flowix-memory'), resolve(profile, 'node_modules/dsh-flowix-memory'), true)
await cp(resolve(repo, 'scripts/dsh-dev-profile.patch.yml'), resolve(profile, 'cordis.patch.yml'))
await writeFile(resolve(profile, 'package.json'), `${JSON.stringify({
  name: 'dsh-profile-flowix',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-appserver', 'dsh-flowix-memory'] } },
}, null, 2)}\n`)

const devHome = resolve(bundle, '.dev-dsh-home')
await mkdir(resolve(devHome, 'profiles'), { recursive: true })
await cp(profile, resolve(devHome, 'profiles/flowix'), { recursive: true })

const nodeDir = resolve(bundle, 'node')
await mkdir(nodeDir, { recursive: true })
await cp(process.execPath, resolve(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node'))
await writeFile(resolve(bundle, 'dsh-runtime.json'), `${JSON.stringify({
  target,
  nodeExecutable: `node/${process.platform === 'win32' ? 'node.exe' : 'node'}`,
  version: process.env.FLOWIX_DSH_VERSION || '1.5.2',
  nodeVersion: process.version,
  nodeAbi: process.versions.modules,
  sourceCommit: JSON.parse(await readFile(resolve(repo, 'dsh/upstream.lock.json'), 'utf8')).commit,
  devBuild: true,
}, null, 2)}\n`)

const runtimeCli = resolve(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
await run(process.execPath, [runtimeCli, '--profile', 'flowix', '--dump-config'], bundle, {
  DSH_HOME: devHome,
  DSH_PROFILE_DIR: profile,
})
await run(process.execPath, [resolve(repo, 'scripts/smoke-dsh-package.mjs'), '--root', bundle], repo)
console.log(`created local DSH development runtime: ${bundle}`)

function targetKey() {
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return `node24-${platform}-${arch}`
}

function run(command, args, cwd, extraEnv = {}) {
  return new Promise((resolveRun, reject) => {
    console.log(`> ${command} ${args.join(' ')}`)
    const child = spawn(command, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)))
  })
}

async function copyTree(source, destination, skipNodeModules = false) {
  await mkdir(dirname(destination), { recursive: true })
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (skipNodeModules && entry.name === 'node_modules') continue
    const from = resolve(source, entry.name)
    const to = resolve(destination, entry.name)
    if (entry.isDirectory()) await copyTree(from, to, skipNodeModules)
    else if (entry.isFile()) await copyFile(from, to)
  }
}

async function materializeLinks(directory) {
  if (!existsSync(directory)) return
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (info.isSymbolicLink()) {
      const source = resolve(dirname(path), await readlink(path))
      let sourceInfo
      try {
        sourceInfo = await lstat(source)
      } catch (error) {
        if (error.code === 'ENOENT') { await rm(path, { force: true }); continue }
        throw error
      }
      await rm(path, { recursive: true, force: true })
      if (sourceInfo.isDirectory()) await copyTree(source, path)
      else await cp(source, path, { force: true })
    } else if (info.isDirectory()) {
      await materializeLinks(path)
    }
  }
}

async function materializeWorkspaceRoots(runtimeRoot, workspaceRoot) {
  const manifestPath = resolve(workspaceRoot, 'python/sdk-runtime/package.json')
  if (!existsSync(manifestPath)) return
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const packages = new Map()
  for (const root of ['apps', 'packages', 'vendor']) await indexPackages(resolve(workspaceRoot, root), packages)
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const destination = resolve(runtimeRoot, 'node_modules', ...name.split('/'))
    if (existsSync(resolve(destination, 'package.json'))) continue
    const source = packages.get(name)
    if (source === undefined) throw new Error(`workspace dependency ${name} was not materialized by pnpm deploy`)
    await copyTree(source, destination)
  }
}

async function indexPackages(directory, packages) {
  if (!existsSync(directory)) return
  const manifest = resolve(directory, 'package.json')
  if (existsSync(manifest)) {
    const value = JSON.parse(await readFile(manifest, 'utf8'))
    if (typeof value.name === 'string') packages.set(value.name, directory)
    return
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
      await indexPackages(resolve(directory, entry.name), packages)
    }
  }
}

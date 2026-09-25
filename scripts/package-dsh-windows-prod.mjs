import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createDshRuntimeMetadata, DSH_PNPM_VERSION } from './dsh-runtime-metadata.mjs'
import { verifyDshNativePackages } from './dsh-native-deps.mjs'

if (process.platform !== 'win32') throw new Error('Windows DSH production packages must be packaged on Windows')
const repo = resolve(import.meta.dirname, '..')
const version = process.env.FLOWIX_DSH_VERSION || '26.09.24'
const minFlowixVersion = process.env.FLOWIX_VERSION || '1.3.2'
const sourceRoot = resolve(repo, '.build/dsh-runtime-bundle/node24-windows-x64')
const stage = resolve(repo, '.build/dsh-prod-stage/node24-windows-x64')
const out = resolve(repo, '.build/releases/dsh')
if (!existsSync(resolve(sourceRoot, 'runtime-build.json'))) {
  throw new Error(`${sourceRoot} is missing; run npm run dsh:build:prod:windows first`)
}

await rm(stage, { recursive: true, force: true })
await mkdir(stage, { recursive: true })
await cp(sourceRoot, stage, { recursive: true })
await verifyDshNativePackages(resolve(stage, 'runtime'), {
  platform: 'win32',
  arch: 'x64',
})
const profile = resolve(stage, 'profile/flowix')
await mkdir(resolve(profile, 'node_modules'), { recursive: true })
await cp(resolve(repo, 'dsh-appserver'), resolve(profile, 'node_modules/dsh-appserver'), { recursive: true, filter: p => !p.includes('node_modules') })
await cp(resolve(repo, 'dsh-flowix-memory'), resolve(profile, 'node_modules/dsh-flowix-memory'), { recursive: true, filter: p => !p.includes('node_modules') })
await cp(resolve(repo, 'scripts/dsh-dev-profile.patch.yml'), resolve(profile, 'cordis.patch.yml'))
await writeFile(resolve(profile, 'package.json'), `${JSON.stringify({
  name: 'dsh-profile-flowix', private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-appserver', 'dsh-flowix-memory'] } },
}, null, 2)}\n`)

const runtimeBuild = JSON.parse(await readFile(resolve(stage, 'runtime-build.json'), 'utf8'))
const metadata = createDshRuntimeMetadata({
  target: 'node24-windows-x64',
  version,
  nodeExecutable: 'node/node.exe',
  nodeVersion: runtimeBuild.nodeVersion,
  nodeAbi: runtimeBuild.nodeAbi,
  pnpmVersion: runtimeBuild.pnpmVersion || DSH_PNPM_VERSION,
})
await writeFile(resolve(stage, 'dsh-runtime.json'), `${JSON.stringify(metadata, null, 2)}\n`)

const nodePath = resolve(stage, 'node/node.exe')
run(nodePath, [resolve(repo, 'scripts/smoke-dsh-package.mjs'), '--root', stage])

await mkdir(out, { recursive: true })
const filename = `Flowix-DSH_${version}_node24-windows-x64.tar.gz`
const archive = resolve(out, filename)
run('tar.exe', ['-czf', archive, '-C', stage, '.'])
run(nodePath, [resolve(repo, 'scripts/verify-dsh-archive.mjs'), '--archive', archive])
const bytes = await readFile(archive)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const signature = signUpdaterArtifact(archive)
const manifest = {
  schemaVersion: 1, product: 'flowix-dsh', version, protocolVersion: 1, minFlowixVersion,
  platforms: { 'windows-x86_64': {
    url: `https://download.flowix-memo.com/dsh/${version}/${filename}?sha256=${sha256}`,
    sha256, signature, sizeBytes: bytes.length, buildId: metadata.buildId,
  } },
}
await mkdir(resolve(out, 'platforms/windows'), { recursive: true })
await writeFile(resolve(out, 'platforms/windows/latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
await writeFile(resolve(out, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`created ${archive} (${sha256})`)

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: repo, env: { ...process.env, ...extraEnv }, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function signUpdaterArtifact(file) {
  const signer = resolve(repo, 'scripts/sign-updater-artifact.mjs')
  const result = spawnSync(process.execPath, [signer, file], { cwd: repo, env: process.env, stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout.trim()
}

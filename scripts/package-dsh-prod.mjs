import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createDshRuntimeMetadata, DSH_PNPM_VERSION } from './dsh-runtime-metadata.mjs'
import { getDshReleaseVersion } from './dsh-release-version.mjs'
import { verifyDshNativePackages } from './dsh-native-deps.mjs'

const repo = resolve(import.meta.dirname, '..')
const version = getDshReleaseVersion()
const minFlowixVersion = process.env.FLOWIX_VERSION || '1.4.8'
const semverPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
if (!semverPattern.test(version)) {
  throw new Error(`invalid DSH package version ${version}; expected SemVer such as 1.5.0`)
}
if (!semverPattern.test(minFlowixVersion)) {
  throw new Error(`invalid minimum Flowix version ${minFlowixVersion}; expected SemVer such as 1.3.2`)
}
const bundleRoot = resolve(repo, '.build/dsh-runtime-bundle')
const out = resolve(repo, '.build/releases/dsh')
const stage = resolve(repo, '.build/dsh-prod-stage')
const nodeEntitlements = resolve(repo, 'scripts/dsh-node.entitlements.plist')
const requiredNodeEntitlements = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-executable-page-protection',
]
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim() || (process.env.FLOWIX_DSH_ADHOC_SIGNING === '1' ? '-' : '')
if (!existsSync(nodeEntitlements)) throw new Error(`DSH Node entitlements are missing: ${nodeEntitlements}`)
if (!signingIdentity) {
  throw new Error('DSH macOS packaging requires APPLE_SIGNING_IDENTITY; use FLOWIX_DSH_ADHOC_SIGNING=1 only for local testing')
}
if (!existsSync(bundleRoot)) {
  throw new Error(`local DSH runtime bundles are missing: ${bundleRoot}; run npm run dsh:build:prod first`)
}

await rm(out, { recursive: true, force: true })
await rm(stage, { recursive: true, force: true })
await mkdir(out, { recursive: true })
const platforms = {}

for (const target of ['node24-macos-arm64', 'node24-macos-x64']) {
  const platform = target.endsWith('arm64') ? 'darwin-aarch64' : 'darwin-x86_64'
  const sourceRoot = resolve(bundleRoot, target)
  if (!existsSync(resolve(sourceRoot, 'runtime-build.json'))) {
    throw new Error(`local DSH runtime bundle is missing for ${target}; run npm run dsh:build:prod under matching Node 24`)
  }
  const targetRoot = resolve(stage, target)
  await mkdir(targetRoot, { recursive: true })
  await cp(sourceRoot, targetRoot, { recursive: true })
  await verifyDshNativePackages(resolve(targetRoot, 'runtime'), {
    platform: 'darwin',
    arch: target.endsWith('arm64') ? 'arm64' : 'x64',
  })

  const profile = resolve(targetRoot, 'profile/flowix')
  await mkdir(resolve(profile, 'node_modules'), { recursive: true })
  await cp(resolve(repo, 'dsh-appserver'), resolve(profile, 'node_modules/dsh-appserver'), { recursive: true, filter: p => !p.includes('/node_modules/') })
  await cp(resolve(repo, 'dsh-flowix-memory'), resolve(profile, 'node_modules/dsh-flowix-memory'), { recursive: true, filter: p => !p.includes('/node_modules/') })
  await cp(resolve(repo, 'scripts/dsh-dev-profile.patch.yml'), resolve(profile, 'cordis.patch.yml'))
  await writeFile(resolve(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-flowix', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-appserver', 'dsh-flowix-memory'] } },
  }, null, 2)}\n`)
  await rm(resolve(targetRoot, 'host'), { recursive: true, force: true })
  await rm(resolve(targetRoot, 'dsh-runtime-dev.json'), { force: true })
  await rm(resolve(targetRoot, '.dev-dsh-home'), { recursive: true, force: true })

  const runtimeBuild = JSON.parse(await readFile(resolve(targetRoot, 'runtime-build.json'), 'utf8'))
  const pnpmEntrypoint = resolve(targetRoot, 'tools/pnpm/node_modules/pnpm/bin/pnpm.mjs')
  if (!existsSync(pnpmEntrypoint)) throw new Error(`DSH Node bundle private pnpm entrypoint is missing: ${pnpmEntrypoint}`)
  const metadataPath = resolve(targetRoot, 'dsh-runtime.json')
  const metadata = createDshRuntimeMetadata({
    target,
    version,
    nodeExecutable: 'node/node',
    nodeVersion: runtimeBuild.nodeVersion,
    nodeAbi: runtimeBuild.nodeAbi,
    pnpmVersion: runtimeBuild.pnpmVersion || DSH_PNPM_VERSION,
  })
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)

  const nodePath = resolve(targetRoot, 'node/node')
  signAndVerifyNode(nodePath, target)

  if (process.env.FLOWIX_DSH_SKIP_HEALTH !== '1') {
    runTargetNode(target, nodePath, [resolve(repo, 'scripts/smoke-dsh-package.mjs'), '--root', targetRoot])
  }
  const filename = `Flowix-DSH_${version}_${target}.tar.gz`
  const archivePath = resolve(out, filename)
  run('tar', ['-czf', archivePath, '-C', targetRoot, '.'])
  runTargetNode(target, nodePath, [resolve(repo, 'scripts/verify-dsh-archive.mjs'), '--archive', archivePath])
  const bytes = await readFile(archivePath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const signature = signUpdaterArtifact(archivePath)
  platforms[platform] = {
    url: `https://download.flowix-memo.com/dsh/${version}/${filename}?sha256=${sha256}`,
    sha256, signature, sizeBytes: bytes.length, buildId: metadata.buildId,
  }
  console.log(`created ${archivePath} (${sha256})`)
}

const output = { schemaVersion: 1, product: 'flowix-dsh', version, protocolVersion: 1, minFlowixVersion, platforms }
await writeFile(resolve(out, 'dsh-latest.json'), `${JSON.stringify(output, null, 2)}\n`)
await mkdir(resolve(out, 'platforms/macos'), { recursive: true })
await writeFile(resolve(out, 'platforms/macos/latest.json'), `${JSON.stringify(output, null, 2)}\n`)
console.log(`created ${resolve(out, 'dsh-latest.json')}`)

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: repo, env: { ...process.env, ...extraEnv }, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function runTargetNode(target, nodePath, args, extraEnv = {}) {
  // The macOS package is built for both architectures. On Apple Silicon,
  // execute the x64 smoke test through Rosetta instead of accidentally
  // validating only the arm64 artifact.
  if (process.platform === 'darwin' && process.arch === 'arm64' && target.endsWith('macos-x64')) {
    run('arch', ['-x86_64', nodePath, ...args], extraEnv)
    return
  }
  run(nodePath, args, extraEnv)
}

function signUpdaterArtifact(file) {
  const signer = resolve(repo, 'scripts/sign-updater-artifact.mjs')
  const result = spawnSync(process.execPath, [signer, file], {
    cwd: repo,
    env: process.env,
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout.trim()
}

function signAndVerifyNode(nodePath, target) {
  const signArgs = ['--force', '--options', 'runtime', '--entitlements', nodeEntitlements]
  if (signingIdentity !== '-') signArgs.push('--timestamp')
  signArgs.push('--sign', signingIdentity, nodePath)
  run('codesign', signArgs)

  run('codesign', ['--verify', '--strict', '--verbose=2', nodePath])
  const details = spawnSync('codesign', ['-d', '--entitlements', ':-', nodePath], {
    cwd: repo,
    encoding: 'utf8',
  })
  const output = `${details.stdout ?? ''}\n${details.stderr ?? ''}`
  const missing = requiredNodeEntitlements.filter(key => !hasTrueEntitlement(output, key))
  if (details.error || details.status !== 0 || missing.length > 0) {
    throw new Error(`DSH Node JIT entitlement verification failed for ${target}; missing=${missing.join(',')}; details=${output.trim()}`)
  }

  // This deliberately runs without --jitless. It catches the exact failure
  // that would otherwise surface only after a user installs the archive.
  runTargetNode(target, nodePath, ['-e', 'if (process.arch.length === 0) process.exit(1)'])
}

function hasTrueEntitlement(output, key) {
  const escaped = key.replaceAll('.', '\\.')
  return new RegExp(`<key>${escaped}</key>\\s*<true\\s*/>`, 'u').test(output)
}

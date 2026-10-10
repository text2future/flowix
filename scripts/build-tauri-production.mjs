import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter } from 'node:path'
import path from 'node:path'
import { applyTauriSigningKey } from './resolve-tauri-signing-key.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..')
// Pi is part of every production desktop package. Keep --with-pi accepted for
// backwards compatibility, but do not require it for the normal build command.
process.env.FLOWIX_BUNDLE_PI = '1'
applyTauriSigningKey()
const npmEntrypoint = process.env.npm_execpath
const tauriEntrypoint = path.resolve(repoRoot, 'node_modules/@tauri-apps/cli/tauri.js')
const cargoTargetDir = path.resolve(process.env.CARGO_TARGET_DIR || path.resolve(repoRoot, '.build/cargo-target'))
process.env.CARGO_TARGET_DIR = cargoTargetDir
if (process.platform === 'win32') {
  const cargoBin = path.join(homedir(), '.cargo', 'bin')
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'Path'
  process.env[pathKey] = `${cargoBin}${delimiter}${process.env[pathKey] ?? ''}`
}
const platformArgIndex = process.argv.indexOf('--platform')
const targetPlatform = platformArgIndex >= 0
  ? process.argv[platformArgIndex + 1]
  : process.platform
const archArgIndex = process.argv.indexOf('--arch')
const requestedArch = archArgIndex >= 0 ? process.argv[archArgIndex + 1] : undefined

if (!['win32', 'darwin', 'linux'].includes(targetPlatform)) {
  throw new Error(`Unsupported --platform value: ${targetPlatform ?? '<missing>'}`)
}
if (targetPlatform === 'win32') {
  run(process.execPath, ['scripts/build-windows-installer-helper.mjs'])
}
if (!npmEntrypoint) {
  throw new Error('Production build must be started through npm run tauri:build:prod')
}
if (
  process.env.FLOWIX_ALLOW_UNSIGNED !== '1'
  && !process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()
  && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH?.trim()
) {
  throw new Error(
    'TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH is required for signed Flowix updater artifacts. '
    + 'Set FLOWIX_ALLOW_UNSIGNED=1 only for local unsigned packages.',
  )
}
if (process.env.TAURI_SIGNING_PRIVATE_KEY_PATH?.trim()
  && !existsSync(process.env.TAURI_SIGNING_PRIVATE_KEY_PATH)) {
  throw new Error(`Tauri signing key path does not exist: ${process.env.TAURI_SIGNING_PRIVATE_KEY_PATH}`)
}

const cargoManifest = readFileSync(path.resolve(repoRoot, 'app/Cargo.toml'), 'utf8')
const cargoVersion = /^version\s*=\s*"([^"]+)"/mu.exec(cargoManifest)?.[1]
const tauriConfig = JSON.parse(readFileSync(
  path.resolve(repoRoot, 'app/flowix-desktop/tauri.conf.json'), 'utf8'))
const packageVersion = JSON.parse(readFileSync(path.resolve(repoRoot, 'package.json'), 'utf8')).version
if (!cargoVersion || cargoVersion !== tauriConfig.version || cargoVersion !== packageVersion) {
  throw new Error(
    `Flowix version mismatch: Cargo=${cargoVersion ?? '<missing>'}, ` +
    `Tauri=${tauriConfig.version ?? '<missing>'}, package=${packageVersion ?? '<missing>'}`,
  )
}

const MACOS_TARGETS = ['aarch64-apple-darwin', 'x86_64-apple-darwin']

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: options.capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    shell: false,
    env: process.env,
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout?.trim()
}

function npmRun(script) {
  run(process.execPath, [npmEntrypoint, 'run', script])
}

if (targetPlatform === 'darwin') {
  if (requestedArch && !['arm64', 'x64'].includes(requestedArch)) {
    throw new Error(`Unsupported macOS --arch value: ${requestedArch}`)
  }
  if (requestedArch) {
    run(process.execPath, [npmEntrypoint, 'run', 'cli:build:prod', '--', `--target=${requestedArch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`])
  } else {
    npmRun('cli:build:prod:macos')
  }
} else if (requestedArch) {
  throw new Error('--arch is currently supported only for macOS production builds')
}
else npmRun('cli:build:prod')

if (process.env.FLOWIX_BUNDLE_PI === '1') {
  const piArgs = ['scripts/prepare-pi-bundle.mjs', '--platform', targetPlatform]
  if (requestedArch) piArgs.push('--arch', requestedArch)
  run(process.execPath, piArgs)
} else {
  run(process.execPath, ['scripts/prepare-pi-catalog.mjs'])
}

const tauriTargets = targetPlatform === 'darwin'
  ? requestedArch
    ? [requestedArch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin']
    : MACOS_TARGETS
  : [null]
const buildStartedAt = Date.now()
for (const target of tauriTargets) {
  if (target) {
    process.env.FLOWIX_PI_TARGET_ARCH = target.startsWith('aarch64-') ? 'arm64' : 'x64'
  } else {
    delete process.env.FLOWIX_PI_TARGET_ARCH
  }
  const configPath = run(
    process.execPath,
    ['scripts/prepare-tauri-production-config.mjs', '--platform', targetPlatform],
    { capture: true },
  )
  if (!configPath) throw new Error('Production config generator did not return a config path.')
  const buildArgs = ['build', '--config', configPath]
  if (target) buildArgs.push('--target', target)
  run(process.execPath, [tauriEntrypoint, ...buildArgs])
}

const freshArtifacts = collectFiles(cargoTargetDir)
  .filter(file => statSync(file).mtimeMs >= buildStartedAt - 2_000)
const requireUpdaterArtifacts = process.env.FLOWIX_ALLOW_UNSIGNED !== '1'
if (targetPlatform === 'win32') {
  const installer = requireArtifact(
    freshArtifacts,
    file => file.endsWith('-setup.exe') && file.includes(`${path.sep}bundle${path.sep}nsis${path.sep}`),
    'NSIS installer',
  )
  if (requireUpdaterArtifacts) {
    requireArtifact(freshArtifacts, file => file === `${installer}.sig`, 'NSIS updater signature')
  }
} else if (targetPlatform === 'darwin') {
  for (const target of tauriTargets) {
    const targetFiles = freshArtifacts.filter(file => file.includes(`${path.sep}${target}${path.sep}`))
    requireArtifact(targetFiles, file => file.endsWith('.dmg'), `${target} DMG`)
    if (requireUpdaterArtifacts) {
      const updater = requireArtifact(targetFiles, file => file.endsWith('.app.tar.gz'), `${target} updater archive`)
      requireArtifact(targetFiles, file => file === `${updater}.sig`, `${target} updater signature`)
    }
  }
} else if (targetPlatform === 'linux') {
  requireArtifact(freshArtifacts, file => file.endsWith('.AppImage'), 'AppImage')
  if (requireUpdaterArtifacts) {
    const updater = requireArtifact(
      freshArtifacts,
      file => file.endsWith('.AppImage.tar.gz'),
      'AppImage updater archive',
    )
    requireArtifact(freshArtifacts, file => file === `${updater}.sig`, 'AppImage updater signature')
  }
}

function collectFiles(root) {
  if (!existsSync(root)) return []
  const files = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) pending.push(candidate)
      else if (entry.isFile()) files.push(candidate)
    }
  }
  return files
}

function requireArtifact(files, predicate, label) {
  const artifact = files.find(predicate)
  if (!artifact) throw new Error(`Tauri reported success but did not create a fresh ${label}`)
  process.stdout.write(`verified ${label}: ${artifact}\n`)
  return artifact
}

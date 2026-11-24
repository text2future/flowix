import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmEntrypoint = process.env.npm_execpath
const tauriEntrypoint = resolve(repoRoot, 'node_modules/@tauri-apps/cli/tauri.js')
const args = process.argv.slice(2)
const withPi = args.includes('--with-pi')
const cloudEnvIndex = args.findIndex(arg => arg === '--cloud-env' || arg.startsWith('--cloud-env='))
const hasCloudEnvFlag = cloudEnvIndex >= 0
const cloudEnvValue = cloudEnvIndex < 0
  ? undefined
  : args[cloudEnvIndex] === '--cloud-env'
    ? args[cloudEnvIndex + 1]
    : args[cloudEnvIndex].slice('--cloud-env='.length)
const configArgs = [...args]
if (cloudEnvIndex >= 0) {
  configArgs.splice(cloudEnvIndex, args[cloudEnvIndex] === '--cloud-env' ? 2 : 1)
}
const config = configArgs.find(arg => arg !== '--with-pi') ?? 'app/flowix-desktop/tauri.conf.dev.json'
const childEnv = { ...process.env }
// Pi is shipped by Flowix; do not let a shell override change the runtime.
delete childEnv.PI_CLI_PATH
childEnv.CARGO_TARGET_DIR ??= resolve(repoRoot, '.build/cargo-target')
const devMode = config.includes('.dev.')
if (devMode) childEnv.FLOWIX_DEV_MODE = '1'
else delete childEnv.FLOWIX_DEV_MODE
if (hasCloudEnvFlag && !['staging', 'cn-staging'].includes(cloudEnvValue)) {
  throw new Error(`Unsupported or missing --cloud-env value: ${cloudEnvValue ?? '<missing>'}. Use staging or cn-staging.`)
}
if (hasCloudEnvFlag && !devMode) {
  throw new Error('--cloud-env can only be used with a development Tauri config.')
}
if (process.env.FLOWIX_CLOUD_API_BASE) {
  throw new Error('FLOWIX_CLOUD_API_BASE has been removed. Use --cloud-env=staging or --cloud-env=cn-staging.')
}
if (devMode) {
  childEnv.FLOWIX_CLOUD_ENVIRONMENT = cloudEnvValue ?? 'staging'
} else {
  childEnv.FLOWIX_CLOUD_ENVIRONMENT = 'prod'
}
console.log(`Cloud build default: ${childEnv.FLOWIX_CLOUD_ENVIRONMENT} (saved dev preference takes precedence)`)

// The dev config is an overlay on tauri.conf.json. Keep versions in the
// overlay-free canonical files aligned so a stale app version fails early.
const packageVersion = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).version
const cargoManifest = readFileSync(resolve(repoRoot, 'app/Cargo.toml'), 'utf8')
const cargoVersion = /^version\s*=\s*"([^"]+)"/mu.exec(cargoManifest)?.[1]
const tauriVersion = JSON.parse(readFileSync(
  resolve(repoRoot, 'app/flowix-desktop/tauri.conf.json'), 'utf8')).version
if (!packageVersion || packageVersion !== cargoVersion || packageVersion !== tauriVersion) {
  throw new Error(
    `Flowix version mismatch: package=${packageVersion ?? '<missing>'}, ` +
    `Cargo=${cargoVersion ?? '<missing>'}, Tauri=${tauriVersion ?? '<missing>'}`,
  )
}

if (process.platform === 'win32') {
  // rustup installs Cargo here by default. GUI shells and automation often do
  // not inherit the updated user PATH until they are restarted.
  const cargoBin = resolve(homedir(), '.cargo', 'bin')
  const pathKey = Object.keys(childEnv).find(key => key.toLowerCase() === 'path') ?? 'Path'
  childEnv[pathKey] = `${cargoBin}${delimiter}${childEnv[pathKey] ?? ''}`

}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: childEnv,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function npmRun(script) {
  if (process.platform === 'win32' && npmEntrypoint) {
    // Node 24 rejects direct spawnSync of some .cmd wrappers with EINVAL.
    run(process.execPath, [npmEntrypoint, 'run', script])
  } else {
    run(npm, ['run', script])
  }
}

npmRun('cli:build:dev')
const piPlatform = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[process.platform]
if (!piPlatform) throw new Error(`Pi v1.1.0 has no release for ${process.platform}`)
const piArch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch
if (!['arm64', 'x64'].includes(piArch)) throw new Error(`Pi v1.1.0 has no release for ${process.platform}-${piArch}`)
const piBinary = process.platform === 'win32' ? 'pi.exe' : 'pi'
const piResourceDir = resolve(repoRoot, '.build', 'pi-runtime', 'resources', `${piPlatform}-${piArch}`)
const stagedPiCandidates = [resolve(piResourceDir, 'dist', piBinary), resolve(piResourceDir, piBinary)]
function hasStagedPi() {
  return stagedPiCandidates.some(candidate => {
    try {
      if (!statSync(candidate).isFile()) return false
      if (process.platform !== 'win32') accessSync(candidate, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

if (withPi || !hasStagedPi()) {
  run(process.execPath, [
    resolve(repoRoot, 'scripts/prepare-pi-bundle.mjs'),
    '--platform',
    process.platform,
    '--arch',
    piArch,
  ])
  if (!hasStagedPi()) throw new Error(`staged Pi executable was not found in ${piResourceDir}`)
  console.log(`prepared bundled Pi v1.1.0 for ${piPlatform}-${piArch}`)
} else if (!existsSync(resolve(repoRoot, '.build', 'pi-runtime', 'provider-catalog.json'))) {
  run(process.execPath, [resolve(repoRoot, 'scripts/prepare-pi-catalog.mjs')])
}
childEnv.FLOWIX_PI_PROVIDER_CATALOG = resolve(repoRoot, '.build', 'pi-runtime', 'provider-catalog.json')
// The desktop app can start without a local DSH source build. Keep the
// heavyweight upstream checkout opt-in for contributors working on DSH itself.
if (process.env.FLOWIX_BUILD_DSH === '1') {
  npmRun('dsh:build:dev')
} else {
  console.log('skipping local DSH build (set FLOWIX_BUILD_DSH=1 to enable)')
}

function runTauriDev() {
  if (process.platform !== 'darwin' || childEnv.FLOWIX_DEV_MODE !== '1') {
    run(process.execPath, [tauriEntrypoint, 'dev', '--config', config])
    return
  }

  const runner = resolve(repoRoot, 'scripts/run-macos-dev-app.mjs')
  const child = spawn(process.execPath, [
    tauriEntrypoint,
    'dev',
    '--config',
    config,
    '--runner',
    runner,
  ], {
    cwd: repoRoot,
    env: childEnv,
    stdio: 'inherit',
  })
  child.on('error', (error) => {
    throw error
  })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
}

runTauriDev()

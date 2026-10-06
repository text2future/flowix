import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmEntrypoint = process.env.npm_execpath
const tauriEntrypoint = resolve(repoRoot, 'node_modules/@tauri-apps/cli/tauri.js')
const args = process.argv.slice(2)
const withPi = args.includes('--with-pi')
const config = args.find(arg => arg !== '--with-pi') ?? 'app/flowix-desktop/tauri.conf.dev.json'
const childEnv = { ...process.env }

function findInstalledFlowixPi() {
  if (childEnv.PI_CLI_PATH) return childEnv.PI_CLI_PATH

  const platform = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[process.platform]
  if (!platform) return undefined
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch
  const executable = process.platform === 'win32' ? 'pi.exe' : 'pi'
  const appRoots = [childEnv.FLOWIX_PROD_APP_PATH]
  if (process.platform === 'darwin') {
    appRoots.push('/Applications/Flowix.app', join(homedir(), 'Applications', 'Flowix.app'))
  } else if (process.platform === 'win32') {
    appRoots.push(
      childEnv.LOCALAPPDATA && join(childEnv.LOCALAPPDATA, 'Programs', 'Flowix'),
      childEnv.ProgramFiles && join(childEnv.ProgramFiles, 'Flowix'),
    )
  } else {
    appRoots.push('/opt/Flowix', '/usr/lib/flowix', '/usr/lib/Flowix')
  }

  for (const appRoot of appRoots.filter(Boolean)) {
    const resourceRoots = process.platform === 'darwin'
      ? [join(appRoot, 'Contents', 'Resources')]
      : [join(appRoot, 'resources'), appRoot]
    for (const resourceRoot of resourceRoots) {
      for (const candidate of [
        join(resourceRoot, 'pi', `${platform}-${arch}`, 'dist', executable),
        join(resourceRoot, 'pi', `${platform}-${arch}`, executable),
      ]) {
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return undefined
}

if (process.platform === 'win32') {
  // rustup installs Cargo here by default. GUI shells and automation often do
  // not inherit the updated user PATH until they are restarted.
  const cargoBin = join(homedir(), '.cargo', 'bin')
  const pathKey = Object.keys(childEnv).find(key => key.toLowerCase() === 'path') ?? 'Path'
  childEnv[pathKey] = `${cargoBin}${delimiter}${childEnv[pathKey] ?? ''}`

}

if (!withPi) {
  const installedPi = findInstalledFlowixPi()
  if (installedPi) {
    childEnv.PI_CLI_PATH = installedPi
    console.log(`using Pi from installed Flowix: ${installedPi}`)
  }
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
if (withPi) {
  const piPlatform = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[process.platform]
  if (!piPlatform) throw new Error(`Pi v1.0.3 has no release for ${process.platform}`)
  run(process.execPath, [
    resolve(repoRoot, 'scripts/prepare-pi-bundle.mjs'),
    '--platform',
    process.platform,
    '--arch',
    process.arch,
  ])
  const piArch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch
  const piBinary = process.platform === 'win32' ? 'pi.exe' : 'pi'
  const piResourceDir = resolve(repoRoot, '.build', 'pi-runtime', 'resources', `${piPlatform}-${piArch}`)
  childEnv.PI_CLI_PATH = [resolve(piResourceDir, 'dist', piBinary), resolve(piResourceDir, piBinary)]
    .find(existsSync)
  if (!childEnv.PI_CLI_PATH) throw new Error(`staged Pi executable was not found in ${piResourceDir}`)
  console.log(`using bundled Pi v1.0.3 from ${childEnv.PI_CLI_PATH}`)
} else {
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

run(process.execPath, [tauriEntrypoint, 'dev', '--config', config])

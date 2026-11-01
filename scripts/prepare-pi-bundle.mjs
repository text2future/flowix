import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { cp, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { copyFile } from 'node:fs/promises'

const repoRoot = path.resolve(import.meta.dirname, '..')
const stageRoot = path.join(repoRoot, '.build', 'pi-runtime')
const downloadCache = path.join(repoRoot, '.build', 'pi-downloads')
const piVersion = '1.1.0'

// Vendored Pi packages installed into every staged resource so the packaged
// app ships them without a runtime `pi install` (which would require npm and
// network access on the user's machine). Pin versions explicitly; the
// installed agent directory is platform independent and reused across all
// staged targets. The desktop runtime seeds it into the user's Pi agent
// directory on first use (agent_external/pi/package_seed.rs).
const vendoredPackages = ['npm:pi-subagents@0.79.2']
const skipVendoredPackages = process.env.FLOWIX_PI_SKIP_PACKAGES === '1'
// The cache key includes the Pi version so a runtime upgrade that changes the
// package install layout cannot reuse a stale vendored agent directory.
const piAgentCache = path.join(
  downloadCache,
  `pi-agent-${createHash('sha256').update([piVersion, ...vendoredPackages].join('\n')).digest('hex').slice(0, 16)}`,
)
const platformArg = process.argv.indexOf('--platform')
const platform = platformArg >= 0 ? process.argv[platformArg + 1] : process.platform
const archValue = process.arch
const archArg = process.argv.indexOf('--arch')
const requestedArch = archArg >= 0 ? process.argv[archArg + 1] : undefined
const arches = requestedArch ? [requestedArch] : platform === 'darwin' ? ['arm64', 'x64'] : [archValue]
const platformName = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[platform]
if (!platformName) throw new Error(`Pi v${piVersion} has no release for ${platform}`)
if (arches.some(arch => !['arm64', 'x64'].includes(arch))) {
  throw new Error(`Pi v${piVersion} has no release for ${platform}-${arches.join(',')}`)
}

const checksums = {
  'darwin-arm64': '3455b13de35c15a5893cdebc922678199e90a7ce99b06cbc23f37860e90d63c7',
  'darwin-x64': '8fdd9149ae27e7470a6a10ed8a7c0ed80738d55adec80a8d7764f6386d1e658b',
  'linux-x64': '3faa94666cd3849d37af320ff749407d0271b07a9b94f420c87e30866e10e289',
  'linux-arm64': 'f3b0cac459f9df5420e4e48b48e95d81bfab57b701dd3fe4b08fda7d11d27dab',
  'windows-x64': '98e3a14e13685a4836a10865bd7887bdc2fcfa1086120313420dc935a401d3d6',
  'windows-arm64': '3dbbff7fae5aa6dfd0224752af2480be66463bf67a11bbbdf050956ba1c170a3',
}

await rm(stageRoot, { recursive: true, force: true })
await mkdir(stageRoot, { recursive: true })
await mkdir(downloadCache, { recursive: true })
const catalogBuild = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'prepare-pi-catalog.mjs')], {
  stdio: 'inherit',
  cwd: repoRoot,
})
if (catalogBuild.error) throw catalogBuild.error
if (catalogBuild.status !== 0) throw new Error('Could not generate the PI provider catalog')
const catalogPath = path.join(stageRoot, 'provider-catalog.json')
const resources = {}
const hostRuntimes = []
for (const arch of arches) {
  const target = `${platformName}-${arch}`
  const extension = platform === 'win32' ? 'zip' : 'tar.gz'
  const archive = `pi-${target}.${extension}`
  const digest = checksums[target]
  if (!digest) throw new Error(`Pi v${piVersion} does not provide a ${target} package`)
  const archivePath = path.join(stageRoot, archive)
  const cachedArchivePath = path.join(downloadCache, archive)
  const url = `https://github.com/earendil-works/pi/releases/download/v${piVersion}/pi-${target}.${extension}`
  const hashFile = async filePath => {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(filePath)) hash.update(chunk)
    return hash.digest('hex')
  }
  let cached = (await stat(cachedArchivePath).catch(() => null))?.isFile() ?? false
  if (cached && await hashFile(cachedArchivePath) !== digest) {
    await rm(cachedArchivePath, { force: true })
    cached = false
  }
  if (!cached) {
    let downloaded = false
    let lastError
    const mirror = `https://gh-proxy.com/${url}`
    const downloadUrls = process.env.FLOWIX_PI_DOWNLOAD_MIRROR_FIRST === '1'
      ? [mirror, url]
      : [url, mirror]
    for (const candidate of downloadUrls) {
      try {
        const response = await fetch(candidate)
        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status} from ${candidate}`)
        }
        await pipeline(Readable.fromWeb(response.body), createWriteStream(cachedArchivePath))
        downloaded = true
        break
      } catch (error) {
        lastError = error
        await rm(cachedArchivePath, { force: true })
      }
    }
    if (!downloaded) throw new Error(`Pi download failed: ${lastError}`)
    const actualDigest = await hashFile(cachedArchivePath)
    if (actualDigest !== digest) throw new Error(`Pi archive SHA-256 mismatch for ${archive}`)
  }
  await copyFile(cachedArchivePath, archivePath)

  const extracted = path.join(stageRoot, `${target}-extract`)
  await mkdir(extracted, { recursive: true })
  const extractArgs = platform === 'win32' ? ['-xf', archivePath, '-C', extracted] : ['-xzf', archivePath, '-C', extracted]
  const extraction = spawnSync('tar', extractArgs, { stdio: 'inherit', cwd: repoRoot })
  if (extraction.error) throw extraction.error
  if (extraction.status !== 0) throw new Error(`Could not extract ${archive}`)

  // Releases may either wrap the package in a top-level `pi/` directory or
  // place the package files directly at the archive root. Keep the staged
  // resource layout identical for both forms.
  const nestedPackageDir = path.join(extracted, 'pi')
  const packageDir = (await stat(nestedPackageDir).catch(() => null))?.isDirectory()
    ? nestedPackageDir
    : extracted
  const binaryName = platform === 'win32' ? 'pi.exe' : 'pi'
  let resolvedBinaryPath
  // Accept both a standalone dist/pi executable and the release package's
  // top-level pi executable.
  for (const candidate of [path.join(packageDir, 'dist', binaryName), path.join(packageDir, binaryName)]) {
    if ((await stat(candidate).catch(() => null))?.isFile()) {
      resolvedBinaryPath = candidate
      break
    }
  }
  if (!resolvedBinaryPath) {
    throw new Error(`Pi ${target} archive did not contain a ${binaryName} executable`)
  }
  const resourceDir = path.join(stageRoot, 'resources', target)
  await mkdir(path.dirname(resourceDir), { recursive: true })
  await rename(packageDir, resourceDir)
  await copyFile(catalogPath, path.join(resourceDir, 'provider-catalog.json'))
  resources[path.resolve(resourceDir)] = `pi/${target}`
  // The executable moves with the rename above, so record its post-rename
  // location for the vendored-package install.
  hostRuntimes.push({
    target,
    binary: path.join(resourceDir, path.relative(packageDir, resolvedBinaryPath)),
  })
}

// Vendor the pinned Pi packages into every staged resource. The install runs
// once with a binary that matches the host machine; the resulting agent
// directory (extensions/, skills/, prompts/, npm/ cache, settings.json) is
// platform independent and copied into each target unchanged.
if (skipVendoredPackages) {
  process.stdout.write('Skipping vendored Pi packages (FLOWIX_PI_SKIP_PACKAGES=1).\n')
} else {
  const hostTarget = `${platformName}-${process.arch}`
  const hostRuntime = hostRuntimes.find(entry => entry.target === hostTarget)
  if (!hostRuntime) {
    throw new Error(
      `Cannot vendor Pi packages: no staged runtime matches this machine (${hostTarget}). ` +
        'Re-run without --platform/--arch overrides or set FLOWIX_PI_SKIP_PACKAGES=1.',
    )
  }
  await stageVendoredPiAgent(hostRuntime.binary)
  for (const resourceDir of Object.keys(resources)) {
    const destination = path.join(resourceDir, 'pi-agent')
    await rm(destination, { recursive: true, force: true })
    await cp(piAgentCache, destination, { recursive: true })
  }
  process.stdout.write(`Vendored Pi packages (${vendoredPackages.join(', ')}) into staged resources.\n`)
}
await mkdir(stageRoot, { recursive: true })
await writeFile(path.join(stageRoot, 'resources.json'), `${JSON.stringify(resources, null, 2)}\n`)
process.stdout.write(`Staged Pi v${piVersion} (${arches.join(', ')}) for ${platformName}.\n`)

async function stageVendoredPiAgent(hostBinary) {
  if (
    (await stat(piAgentCache).catch(() => null))?.isDirectory() &&
    (await stat(path.join(piAgentCache, 'settings.json')).catch(() => null))?.isFile()
  ) {
    return
  }
  const staging = path.join(downloadCache, `.pi-agent-stage-${process.pid}`)
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  const install = spawnSync(hostBinary, ['install', ...vendoredPackages], {
    stdio: 'inherit',
    cwd: repoRoot,
    env: { ...process.env, PI_CODING_AGENT_DIR: staging },
    timeout: 5 * 60_000,
  })
  if (install.error) throw install.error
  if (install.status !== 0) {
    throw new Error(`pi install failed for ${vendoredPackages.join(', ')}`)
  }
  if (!(await stat(path.join(staging, 'settings.json')).catch(() => null))?.isFile()) {
    throw new Error('pi install did not produce a Pi agent settings.json')
  }
  await rm(piAgentCache, { recursive: true, force: true })
  await rename(staging, piAgentCache)
}

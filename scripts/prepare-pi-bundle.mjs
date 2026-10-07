import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { copyFile } from 'node:fs/promises'

const repoRoot = path.resolve(import.meta.dirname, '..')
const stageRoot = path.join(repoRoot, '.build', 'pi-runtime')
const downloadCache = path.join(repoRoot, '.build', 'pi-downloads')
const platformArg = process.argv.indexOf('--platform')
const platform = platformArg >= 0 ? process.argv[platformArg + 1] : process.platform
const archValue = process.arch
const archArg = process.argv.indexOf('--arch')
const requestedArch = archArg >= 0 ? process.argv[archArg + 1] : undefined
const arches = requestedArch ? [requestedArch] : platform === 'darwin' ? ['arm64', 'x64'] : [archValue]
const platformName = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[platform]
if (!platformName) throw new Error(`Pi v1.0.3 has no release for ${platform}`)
if (arches.some(arch => !['arm64', 'x64'].includes(arch))) {
  throw new Error(`Pi v1.0.3 has no release for ${platform}-${arches.join(',')}`)
}

const checksums = {
  'darwin-arm64': '7b1aa89ba13542f1aca61ebd63486d0417b5d2fefd5c41ededd8d083ab719b23',
  'darwin-x64': '769e0c1d599dbc8e63ac355957bec8e9832bff91f190d67432392e62ac552194',
  'linux-x64': '9b8c7ff523bd90881d1c1505168f0b9deb2c0357396b92b62f799550a48ff1ed',
  'linux-arm64': 'd3093a79ac9e22ef430e2a73e002a3ddeb451de07b722b3aa53aa6a94eaa9edc',
  'windows-x64': '6cddc3d11210539faa7ba0188504813f2f3ae6d8f93a161d4145cc61a8bdd5de',
  'windows-arm64': 'ac29f24c02342886fa2d3c1c4629ae4e40d530357535b6a60b5c8ecaf803a11f',
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
for (const arch of arches) {
  const target = `${platformName}-${arch}`
  const extension = platform === 'win32' ? 'zip' : 'tar.gz'
  const archive = `pi-${target}.${extension}`
  const digest = checksums[target]
  if (!digest) throw new Error(`Pi v1.0.3 does not provide a ${target} package`)
  const archivePath = path.join(stageRoot, archive)
  const cachedArchivePath = path.join(downloadCache, archive)
  const url = `https://github.com/earendil-works/pi/releases/download/v1.0.3/${archive}`
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

  const packageDir = path.join(extracted, 'pi')
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
}
await mkdir(stageRoot, { recursive: true })
await writeFile(path.join(stageRoot, 'resources.json'), `${JSON.stringify(resources, null, 2)}\n`)
process.stdout.write(`Staged Pi v1.0.3 (${arches.join(', ')}) for ${platformName}.\n`)

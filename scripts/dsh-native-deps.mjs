import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * pnpm deploy may materialize optional native packages as a placeholder
 * package.json, while leaving the platform package behind. DSH imports the
 * koffi wrapper during every fresh host boot, so both packages must come from
 * the same installed dependency tree.
 */
export async function repairDshNativePackages(runtimeRoot, workspaceRoot, {
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const nativeName = `@koromix/koffi-${platform}-${arch}`
  const wrapperSource = await findInstalledPackage(workspaceRoot, 'koffi')
  if (!wrapperSource) throw missingDependency('koffi', platform, arch)
  const wrapperManifest = await readPackageManifest(wrapperSource)
  const expectedVersion = wrapperManifest.optionalDependencies?.[nativeName]
  if (typeof expectedVersion !== 'string' || expectedVersion.length === 0) {
    throw new Error(`installed koffi does not declare ${nativeName} as an optional dependency`)
  }

  await repairOptionalNativePackage(runtimeRoot, wrapperSource, 'koffi', wrapperManifest.version)
  const nativeSource = await findInstalledPackage(workspaceRoot, nativeName, expectedVersion)
  if (!nativeSource) throw missingDependency(`${nativeName}@${expectedVersion}`, platform, arch)
  await repairOptionalNativePackage(runtimeRoot, nativeSource, nativeName, expectedVersion)

  // The system addon currently ships only POSIX (Linux/macOS) binaries.
  // Windows does not declare a platform package and must not be treated as a
  // missing dependency during a local desktop build.
  if (platform !== 'win32') {
    const systemNativeName = `@deepseek-ai/node-addon-system-${platform}-${arch}`
    const systemSource = await findInstalledPackage(workspaceRoot, systemNativeName)
    if (!systemSource) throw missingDependency(systemNativeName, platform, arch)
    const systemManifest = await readPackageManifest(systemSource)
    await repairOptionalNativePackage(runtimeRoot, systemSource, systemNativeName, systemManifest.version, true)
  }
}

/**
 * Fail the build before an archive is produced if pnpm's optional dependency
 * handling leaves an unusable koffi installation behind.
 */
export async function verifyDshNativePackages(runtimeRoot, {
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const nativeName = `@koromix/koffi-${platform}-${arch}`
  const wrapperRoot = packageRoot(runtimeRoot, 'koffi')
  const nativeRoot = packageRoot(runtimeRoot, nativeName)
  const wrapper = await verifyPackage(wrapperRoot, 'koffi')
  const native = await verifyPackage(nativeRoot, nativeName)
  const expectedVersion = wrapper.optionalDependencies?.[nativeName]
  if (typeof expectedVersion !== 'string') {
    throw new Error(`koffi does not declare its platform package ${nativeName}`)
  }
  if (native.version !== expectedVersion) {
    throw new Error(
      `DSH runtime native Koffi version mismatch: koffi expects ${nativeName}@${expectedVersion}, `
      + `but the runtime contains ${native.version ?? '<missing>'}`,
    )
  }
  await verifyNativeBinary(nativeRoot, platform, arch, nativeName)
  return { wrapperVersion: wrapper.version, nativeVersion: native.version, nativeName }
}

async function repairOptionalNativePackage(runtimeRoot, source, packageName, expectedVersion, force = false) {
  const target = packageRoot(runtimeRoot, packageName)
  const sourceManifest = await readPackageManifest(source)
  if (sourceManifest.version !== expectedVersion) {
    throw new Error(`${packageName} source version mismatch: expected ${expectedVersion}, got ${sourceManifest.version ?? '<missing>'}`)
  }
  const targetManifest = await tryReadPackageManifest(target)
  if (!force && targetManifest?.version === expectedVersion && !targetManifest._pnpmPlaceholder) return

  await rm(target, { recursive: true, force: true })
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, { recursive: true, force: true, dereference: true })
}

async function findInstalledPackage(workspaceRoot, packageName, expectedVersion) {
  const candidates = []
  const direct = resolve(workspaceRoot, 'node_modules/.pnpm/node_modules', ...packageName.split('/'))
  candidates.push(direct)

  const virtualStore = resolve(workspaceRoot, 'node_modules/.pnpm')
  if (existsSync(virtualStore)) {
    const entries = await readdir(virtualStore, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) candidates.push(resolve(virtualStore, entry.name, 'node_modules', ...packageName.split('/')))
    }
  }

  const seen = new Set()
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    const manifest = await tryReadPackageManifest(candidate)
    if (!manifest || manifest._pnpmPlaceholder) continue
    if (expectedVersion !== undefined && manifest.version !== expectedVersion) continue
    if (manifest.name !== packageName) continue
    return candidate
  }
  return null
}

async function verifyPackage(root, packageName) {
  const manifest = await tryReadPackageManifest(root)
  if (!manifest) throw new Error(`DSH runtime is missing native package ${packageName}`)
  if (manifest._pnpmPlaceholder) throw new Error(`DSH runtime native package ${packageName} is still a pnpm placeholder`)
  const entries = [manifest.module, manifest.main]
    .filter(value => typeof value === 'string' && value.length > 0)
  if (!entries.some(entry => existsSync(resolve(root, entry)))) {
    throw new Error(`DSH runtime native package ${packageName} has no loadable entrypoint`)
  }
  return manifest
}

async function verifyNativeBinary(root, platform, arch, packageName) {
  const binaries = await findFiles(root, value => value.endsWith('.node'))
  if (binaries.length === 0) throw new Error(`DSH runtime native package ${packageName} contains no .node binary`)
  const matches = await Promise.all(binaries.map(file => nativeBinaryMatches(file, platform, arch)))
  if (!matches.some(Boolean)) {
    throw new Error(`DSH runtime native package ${packageName} has no ${platform}/${arch} .node binary (found ${binaries.join(', ')})`)
  }
}

async function findFiles(root, predicate) {
  if (!existsSync(root)) return []
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) result.push(...await findFiles(path, predicate))
    else if (entry.isFile() && predicate(path)) result.push(path)
  }
  return result
}

function nativeBinaryMatches(path, platform, arch) {
  // Reading the header directly keeps this check portable; it does not depend
  // on the host having `file(1)` installed.
  return readFile(path).then(bytes => {
    if (platform === 'darwin') return machOHasArchitecture(bytes, arch)
    if (platform === 'linux') return elfHasArchitecture(bytes, arch)
    if (platform === 'win32') return peHasArchitecture(bytes, arch)
    throw new Error(`unsupported native binary platform ${platform}`)
  })
}

function machOHasArchitecture(bytes, arch) {
  const desired = arch === 'arm64' ? 0x0100000c : arch === 'x64' ? 0x01000007 : null
  if (desired === null || bytes.length < 8) return false
  if (bytes.readUInt32LE(0) === 0xfeedfacf) return bytes.readUInt32LE(4) === desired
  const magic = bytes.readUInt32BE(0)
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) return false
  const count = bytes.readUInt32BE(4)
  const entrySize = magic === 0xcafebabf ? 32 : 20
  for (let offset = 8; offset + entrySize <= bytes.length && offset < 8 + count * entrySize; offset += entrySize) {
    if (bytes.readUInt32BE(offset) === desired) return true
  }
  return false
}

function elfHasArchitecture(bytes, arch) {
  if (bytes.length < 20 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) return false
  const machine = bytes.readUInt16LE(18)
  return (arch === 'arm64' && machine === 183) || (arch === 'x64' && machine === 62)
}

function peHasArchitecture(bytes, arch) {
  if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return false
  const offset = bytes.readUInt32LE(0x3c)
  if (offset + 6 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0') return false
  const machine = bytes.readUInt16LE(offset + 4)
  return (arch === 'arm64' && machine === 0xaa64) || (arch === 'x64' && machine === 0x8664)
}

function packageRoot(runtimeRoot, packageName) {
  return resolve(runtimeRoot, 'node_modules', ...packageName.split('/'))
}

async function readPackageManifest(root) {
  return JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
}

async function tryReadPackageManifest(root) {
  try { return await readPackageManifest(root) } catch (_) { return null }
}

function missingDependency(packageName, platform, arch) {
  return new Error(`DSH build dependencies are missing ${packageName} for ${platform}/${arch}; run pnpm install for the target architecture before building`)
}

export const __test = { machOHasArchitecture, elfHasArchitecture, peHasArchitecture, findInstalledPackage }

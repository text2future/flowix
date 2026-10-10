import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const target = 'x86_64-pc-windows-msvc'
const targetDir = path.resolve(process.env.CARGO_TARGET_DIR || path.join(repoRoot, 'app/target'))
const stagedHelper = path.join(repoRoot, 'app/flowix-desktop/nsis/flowix-installer-helper.exe')
const compiledHelper = path.join(targetDir, target, 'release/flowix-installer-helper.exe')
const env = { ...process.env, CARGO_TARGET_DIR: targetDir }

const build = spawnSync('cargo', [
  'build', '--release', '--manifest-path', path.join(repoRoot, 'app/Cargo.toml'),
  '--package', 'flowix-installer-helper', '--bin', 'flowix-installer-helper', '--target', target,
], { cwd: repoRoot, env, stdio: 'inherit', shell: process.platform === 'win32' })
if (build.error) throw build.error
if (build.status !== 0) process.exit(build.status ?? 1)
if (!existsSync(compiledHelper)) throw new Error(`installer helper build produced no file: ${compiledHelper}`)

mkdirSync(path.dirname(stagedHelper), { recursive: true })
copyFileSync(compiledHelper, stagedHelper)

const thumbprint = process.env.WINDOWS_CERT_THUMBPRINT?.replaceAll(' ', '').trim()
if (thumbprint) {
  const timestampUrl = process.env.WINDOWS_TIMESTAMP_URL?.trim() || 'http://timestamp.sectigo.com'
  const sign = spawnSync('signtool.exe', [
    'sign', '/sha1', thumbprint, '/fd', 'SHA256', '/tr', timestampUrl, '/td', 'SHA256', stagedHelper,
  ], { cwd: repoRoot, env, stdio: 'inherit', shell: process.platform === 'win32' })
  if (sign.error) throw sign.error
  if (sign.status !== 0) process.exit(sign.status ?? 1)
} else if (process.env.FLOWIX_REQUIRE_SIGNED_INSTALLER_HELPER === '1') {
  throw new Error('WINDOWS_CERT_THUMBPRINT is required to sign the installer helper.')
}

process.stdout.write(`staged Windows installer helper: ${stagedHelper}\n`)

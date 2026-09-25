import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const archiveFlag = process.argv.indexOf('--archive')
const archive = archiveFlag >= 0 ? process.argv[archiveFlag + 1] : process.argv[2]
if (!archive) throw new Error('usage: node verify-dsh-archive.mjs --archive <archive.tar.gz>')

const repo = resolve(import.meta.dirname, '..')
// macOS exposes the system temp directory through /var, while APIs that
// resolve project skill paths may return the canonical /private/var path.
// Keep the extracted runtime and the paths it observes on one canonical path.
const extraction = await realpath(await mkdtemp(resolve(tmpdir(), 'flowix-dsh-archive-')))
try {
  run(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xzf', resolve(archive), '-C', extraction])
  const metadata = JSON.parse(await readFile(resolve(extraction, 'dsh-runtime.json'), 'utf8'))
  const nodePath = resolve(extraction, metadata.nodeExecutable ?? 'node/node')
  const smoke = resolve(repo, 'scripts/smoke-dsh-package.mjs')
  if (process.platform === 'darwin' && process.arch === 'arm64' && metadata.target?.endsWith('x64')) {
    run('arch', ['-x86_64', nodePath, smoke, '--root', extraction])
  } else {
    run(nodePath, [smoke, '--root', extraction])
  }
  console.log(`DSH archive smoke passed: ${resolve(archive)}`)
} finally {
  await rm(extraction, { recursive: true, force: true })
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repo, env: process.env, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}

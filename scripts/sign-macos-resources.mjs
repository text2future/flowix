import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = path.resolve(import.meta.dirname, '..')
const resourcesRoot = path.join(repoRoot, '.build', 'pi-runtime', 'resources')
const identity = process.env.APPLE_SIGNING_IDENTITY?.trim()

if (!identity) {
  throw new Error('APPLE_SIGNING_IDENTITY is required to sign bundled macOS resources.')
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} failed for ${args.at(-1)} (exit ${result.status ?? 1})`)
  }
  return result.stdout.trim()
}

function walk(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(candidate))
    else if (entry.isFile()) files.push(candidate)
  }
  return files
}

const resources = walk(resourcesRoot)
const binaries = resources.filter(file => run('file', ['-b', file]).includes('Mach-O'))
if (binaries.length === 0) {
  throw new Error(`No Mach-O binaries found in bundled resources: ${resourcesRoot}`)
}

for (const binary of binaries) {
  run('codesign', [
    '--force',
    '--timestamp',
    '--options', 'runtime',
    '--sign', identity,
    binary,
  ])
  run('codesign', ['--verify', '--strict', '--verbose=2', binary])
  process.stdout.write(`Signed macOS resource: ${path.relative(repoRoot, binary)}\n`)
}

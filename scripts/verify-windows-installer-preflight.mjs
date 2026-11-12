// Exercise the production NSIS hook with Tauri's full executable path argument.
// The fixture runs preflight/result callbacks in .build; it does not install Flowix.
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

if (process.platform !== 'win32') throw new Error('Windows is required')
const repo = path.resolve(import.meta.dirname, '..')
const build = path.join(repo, '.build')
mkdirSync(build, { recursive: true })
const fixture = mkdtempSync(path.join(build, 'installer-preflight-'))
const attempt = randomUUID()
const install = path.join(fixture, 'install with spaces')
const state = path.join(fixture, 'state')
mkdirSync(install)
mkdirSync(state)
writeFileSync(path.join(install, 'Flowix test.exe'), '')

const hooks = readFileSync(path.join(repo, 'app/flowix-desktop/nsis/flowix-cli-path.nsh'), 'utf8')
function macro(name) {
  const value = hooks.match(new RegExp(`!macro ${name}\\b[^\\r\\n]*[\\s\\S]*?!macroend`))?.[0]
  if (!value) throw new Error(`Missing production macro: ${name}`)
  return value
}
const nsis = path.join(process.env.LOCALAPPDATA, 'tauri/NSIS/makensis.exe')
const helper = process.env.FLOWIX_INSTALLER_HELPER || path.join(repo, 'app/flowix-desktop/nsis/flowix-installer-helper.exe')
if (!existsSync(nsis) || !existsSync(helper)) throw new Error('Build the Windows installer helper and install Tauri NSIS first')
const harness = path.join(fixture, 'preflight.exe')
const source = path.join(fixture, 'preflight.nsi')
const harnessSource = `Unicode true
RequestExecutionLevel user
SilentInstall silent
!include LogicLib.nsh
!include FileFunc.nsh
Name "Flowix preflight regression check"
OutFile "${harness}"
!define FLOWIX_STATE_DIR "${state}"
!define FLOWIX_HELPER_SOURCE "${helper}"
Var FlowixSavedOutDir
Var FlowixUpdateAttempt
Var FlowixIsUpdate
Var FlowixInstallerVersion
${macro('FLOWIX_PARSE_UPDATE_MODE')}
${macro('FLOWIX_EXTRACT_HELPER')}
${macro('FLOWIX_RUN_HELPER')}
${macro('FLOWIX_RECORD_UPDATE_RESULT')}
${macro('FLOWIX_LOG')}
${macro('CheckIfAppIsRunning')}
${hooks.match(/Function \.onInstFailed[\s\S]*?FunctionEnd/)[0]}
; Match Tauri's include order: version constants follow the hook callbacks.
!define VERSION "preflight-check"
Section
  StrCpy $INSTDIR "${install}"
  !insertmacro CheckIfAppIsRunning "$INSTDIR\\Flowix test.exe" "Flowix test"
  !insertmacro FLOWIX_RECORD_UPDATE_RESULT "success" ""
SectionEnd
`
function run(command, args, expectedStatus = 0) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60000 })
  if (result.error || result.status !== expectedStatus ||
      (command === nsis && /warning 6000:/u.test(`${result.stdout}\n${result.stderr}`))) {
    const logFile = path.join(state, 'app-update.log')
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    throw new Error(`Preflight check failed (${result.status}): ${result.error ?? ''}\n${result.stdout}\n${result.stderr}\n${log}`)
  }
}
for (const mode of ['quiet', 'passive']) {
  writeFileSync(path.join(state, 'app-update-state.json'), JSON.stringify({
    schema: 1, attempt_id: attempt, target_version: 'preflight-check', status: 'pending', message: null,
  }))
  // Start hidden, then switch NSIS to non-silent for the passive-mode callback.
  // An old IfSilent-based result hook must fail this case.
  const modeSource = harnessSource.replace(
    '!insertmacro FLOWIX_RECORD_UPDATE_RESULT "success" ""',
    `${mode === 'passive' ? 'SetSilent normal' : ''}\n  !insertmacro FLOWIX_RECORD_UPDATE_RESULT "success" ""\n  SetSilent silent`,
  )
  writeFileSync(source, modeSource)
  run(nsis, ['/V2', source])
  run(harness, ['/S', '/UPDATE', `/FLOWIXATTEMPT=${attempt}`])
  const result = JSON.parse(readFileSync(path.join(state, 'app-update-state.json'), 'utf8'))
  if (result.status !== 'success' || result.attempt_id !== attempt) throw new Error(`${mode} result was not recorded`)
}
// Abort after successful preflight and ensure the real failure callback persists
// the UTF-16 error file without shell quoting or codepage loss.
const failureMessage = '\u6587\u4ef6\u88ab\u5360\u7528 "Flowix test.exe" | retry'
const errorSource = path.join(fixture, 'error-source.txt')
writeFileSync(errorSource, Buffer.from(failureMessage, 'utf16le'))
writeFileSync(path.join(state, 'app-update-state.json'), JSON.stringify({
  schema: 1, attempt_id: attempt, target_version: 'preflight-check', status: 'pending', message: null,
}))
writeFileSync(source, harnessSource.replace(
  '!insertmacro FLOWIX_RECORD_UPDATE_RESULT "success" ""',
  `CopyFiles /SILENT "${errorSource}" "$PLUGINSDIR\\flowix-error.txt"\n  Abort`,
))
run(nsis, ['/V2', source])
run(harness, ['/S', '/UPDATE', `/FLOWIXATTEMPT=${attempt}`], 1)
const failure = JSON.parse(readFileSync(path.join(state, 'app-update-state.json'), 'utf8'))
if (failure.status !== 'failed' || failure.message !== failureMessage) throw new Error('Failure callback lost the original error')
// A failure before CheckIfAppIsRunning has no captured package VERSION yet.
// It must still record a failure for this exact attempt, never claim success.
writeFileSync(path.join(state, 'app-update-state.json'), JSON.stringify({
  schema: 1, attempt_id: attempt, target_version: 'preflight-check', status: 'pending', message: null,
}))
writeFileSync(source, harnessSource.replace(/Section\n[\s\S]*?SectionEnd/, 'Section\n  Abort\nSectionEnd'))
run(nsis, ['/V2', source])
run(harness, ['/S', '/UPDATE', `/FLOWIXATTEMPT=${attempt}`], 1)
if (JSON.parse(readFileSync(path.join(state, 'app-update-state.json'), 'utf8')).status !== 'failed') throw new Error('Early failure was not recorded')

// An installed older app supplies only the two legacy markers and no UUID.
unlinkSync(path.join(state, 'app-update-state.json'))
writeFileSync(path.join(state, 'app-update-target.txt'), 'preflight-check')
writeFileSync(path.join(state, 'app-update-result.txt'), 'pending|preflight-check')
writeFileSync(source, harnessSource)
run(nsis, ['/V2', source])
run(harness, ['/S', '/UPDATE'])
if (!readFileSync(path.join(state, 'app-update-result.txt'), 'utf8').startsWith('success|')) throw new Error('Legacy client result was not preserved')
// Successful manual installs clear both protocol versions using the same runner.
writeFileSync(source, harnessSource.replace(
  '!insertmacro FLOWIX_RECORD_UPDATE_RESULT "success" ""',
  `!insertmacro FLOWIX_RUN_HELPER "clear-update" '--state-dir "${state}"'`,
))
run(nsis, ['/V2', source])
run(harness, ['/S'])
for (const name of ['app-update-state.json', 'app-update-target.txt', 'app-update-result.txt']) {
  if (existsSync(path.join(state, name))) throw new Error(`Manual-install cleanup left ${name}`)
}
const log = readFileSync(path.join(state, 'app-update.log'), 'utf8')
if (!log.includes('preflight-ready') || log.includes('preflight-failed')) throw new Error(log)
console.log('Verified production NSIS preflight, full paths with spaces, quiet/passive results, early/Unicode failures, legacy compatibility, and manual-install cleanup.')
console.log(`Fixture and log: ${fixture}`)

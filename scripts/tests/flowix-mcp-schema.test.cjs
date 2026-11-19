// Run after building flowix-cli: node --test scripts/tests/flowix-mcp-schema.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const Ajv = require('ajv')

const cli = process.env.FLOWIX_TEST_CLI || path.resolve(__dirname, '../../app/target/debug/flowix-cli')
function requests(items) {
  const input = items.map((item, index) => JSON.stringify({jsonrpc:'2.0',id:index+1,...item})).join('\n') + '\n'
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flowix-schema-'))
  const result = spawnSync(cli, ['mcp'], { input, encoding:'utf8', env:{...process.env, FLOWIX_HOME:home, FLOWIX_MCP_ACCESS:'full'} })
  fs.rmSync(home, {recursive:true,force:true})
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim().split('\n').map(line => JSON.parse(line))
}

test('MCP schemas and runtime reject invalid action contracts', () => {
  const definitions = requests([{method:'tools/list',params:{}}])[0].result.tools
  const ajv = new Ajv({strict:false})
  const validators = Object.fromEntries(definitions.map(tool => [tool.name, ajv.compile(tool.inputSchema)]))
  const cases = [
    ['flowix_read', {action:'show'}],
    ['flowix_read', {action:'request.show',notebook:'work',operation:'create'}],
    ['flowix_read', {action:'request.show',notebook:'work',operation:'collection.add',requestId:'id'}],
    ['flowix_read', {action:'request.list',state:'missing'}],
    ['flowix_read', {action:'show',address:'x',content:'unexpected'}],
    ['flowix_read', {action:'delete',address:'x',expectedVersion:'x'}],
    ['flowix_write', {action:'create',content:'body'}],
    ['flowix_write', {action:'create',content:'body',requestId:'  '}],
    ['flowix_write', {action:'write',address:'x',content:'body'}],
    ['flowix_delete', {action:'delete',address:'x'}],
    ['flowix_delete', {action:'delete',address:'x',expectedVersion:'  '}],
    ['flowix_read', {action:'collection.query',path:'x',sort:[{field:'name',direction:null}]}],
    ['flowix_read', {action:'collection.query',path:'x',sort:[{field:'name',extra:true}]}],
    ['flowix_write', {action:'collection.add',record:{},requestId:'id'}],
    ['flowix_write', {action:'collection.add-note',title:'x',content:'x',requestId:'id'}],
    ['flowix_write', {action:'artifact.create',content:'x',requestId:'id'}],
  ]
  const responses = requests(cases.map(([name,arguments_]) => ({method:'tools/call',params:{name,arguments:arguments_}})))
  cases.forEach(([name,args],index) => {
    assert.equal(validators[name](args), false, `${name}: ${JSON.stringify(args)}`)
    assert.equal(responses[index].result?.isError, true, JSON.stringify(responses[index]))
  })
  assert.equal(validators.flowix_read({action:'show',address:'notebook::note.md'}), true)
  assert.equal(validators.flowix_read({action:'request.show',notebook:'work',operation:'create',requestId:'id'}), true)
  assert.equal(validators.flowix_write({action:'create',content:'body',requestId:'id'}), true)
})

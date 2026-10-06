import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const outputPath = path.join(repoRoot, '.build', 'pi-runtime', 'provider-catalog.json')
const { builtinProviders, getBuiltinModels, getBuiltinProviders } = await import('@earendil-works/pi-ai/providers/all')
const builtinProviderInstances = new Map(builtinProviders().map(provider => [provider.id, provider]))
const providers = getBuiltinProviders().flatMap(id => {
  const provider = builtinProviderInstances.get(id)
  const allModels = getBuiltinModels(id)
  const api = allModels[0]?.api
  if (!provider || !api || allModels.length === 0) return []
  return [{
    id,
    displayName: provider.name || id,
    api,
    baseUrl: allModels.find(model => model.api === api && model.baseUrl)?.baseUrl || provider.baseUrl || '',
    takesApiKey: Boolean(provider.auth?.apiKey),
    models: allModels.map(model => ({
      id: model.id,
      name: model.name || model.id,
      api: model.api,
      reasoning: Boolean(model.reasoning),
      vision: model.input?.includes('image') ?? false,
      ...(Number.isFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
      ...(Number.isFinite(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
    })),
  }]
})
const apis = [...new Set(providers.flatMap(provider => provider.models.map(model => model.api)).filter(Boolean))].sort()
const lock = JSON.parse(await readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'))
const piAiVersion = lock.packages?.['node_modules/@earendil-works/pi-ai']?.version
if (!piAiVersion) throw new Error('The locked @earendil-works/pi-ai version is missing from package-lock.json')
const piPackage = JSON.parse(await readFile(path.join(repoRoot, 'node_modules/@earendil-works/pi-ai/package.json'), 'utf8'))
if (piPackage.version !== piAiVersion) throw new Error(`Installed pi-ai ${piPackage.version} does not match locked ${piAiVersion}`)

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify({ piVersion: '1.0.3', piAiVersion, apis, providers }, null, 2)}\n`)
process.stdout.write(`Generated ${path.relative(repoRoot, outputPath)} (${providers.length} providers, ${apis.length} APIs).\n`)

import fs from 'node:fs';
import path from 'node:path';

// Args: [--release-dir <dir>] <manifest> <version> <artifact-prefix> <platform...>
//   --release-dir   where artifacts live on disk (defaults to the manifest's parent dir).
//                   Per-platform manifests in release.sh live at
//                   ${RELEASE_OUT}/updater/<group>/latest.json but their artifacts
//                   sit at ${RELEASE_OUT}/, so callers always pass --release-dir.
const rawArgs = process.argv.slice(2);
let releaseDirOverride = null;
let positional = rawArgs;
for (let i = 0; i < rawArgs.length; i += 1) {
  if (rawArgs[i] === '--release-dir') {
    releaseDirOverride = rawArgs[i + 1];
    positional = [...rawArgs.slice(0, i), ...rawArgs.slice(i + 2)];
    break;
  }
}
const [manifestPath, expectedVersion, expectedPrefixArg, ...requiredPlatforms] = positional;

if (!manifestPath || !expectedVersion || !expectedPrefixArg || requiredPlatforms.length === 0) {
  console.error('Usage: node scripts/verify-updater-release.mjs [--release-dir <dir>] <latest.json> <version> <artifact-prefix> <platform...>');
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const releaseDir = releaseDirOverride
  ? path.resolve(releaseDirOverride)
  : path.dirname(path.resolve(manifestPath));

if (manifest.version !== expectedVersion) {
  throw new Error(`manifest version mismatch: expected ${expectedVersion}, got ${manifest.version ?? '<missing>'}`);
}
if (!manifest.pub_date || Number.isNaN(Date.parse(manifest.pub_date))) {
  throw new Error('manifest pub_date is missing or invalid');
}
if (!manifest.platforms || typeof manifest.platforms !== 'object' || Array.isArray(manifest.platforms)) {
  throw new Error('manifest platforms must be an object');
}

const expectedPrefix = expectedPrefixArg.replace(/^\/+|\/+$/gu, '');
for (const platform of requiredPlatforms) {
  const entry = manifest.platforms[platform];
  if (!entry || typeof entry !== 'object') {
    throw new Error(`manifest is missing required platform ${platform}`);
  }
  if (typeof entry.url !== 'string' || !entry.url.trim()) {
    throw new Error(`manifest URL is missing for ${platform}`);
  }
  if (typeof entry.signature !== 'string' || !entry.signature.trim()) {
    throw new Error(`manifest signature is missing for ${platform}`);
  }

  const url = new URL(entry.url);
  const segments = url.pathname.split('/').filter(Boolean);
  const normalizedPath = `/${segments.join('/')}/`;
  if (!normalizedPath.includes(`/${expectedPrefix}/`)) {
    throw new Error(`manifest URL for ${platform} does not point to ${expectedPrefix}`);
  }

  const artifactName = decodeURIComponent(segments.at(-1) ?? '');
  if (!artifactName || path.basename(artifactName) !== artifactName) {
    throw new Error(`manifest URL for ${platform} has an invalid artifact name`);
  }
  for (const fileName of [artifactName, `${artifactName}.sig`]) {
    if (!fs.statSync(path.join(releaseDir, fileName), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`release file is missing for ${platform}: ${fileName}`);
    }
  }
  const signature = fs.readFileSync(path.join(releaseDir, `${artifactName}.sig`), 'utf8').trim();
  if (signature !== entry.signature.trim()) {
    throw new Error(`manifest signature does not match release file for ${platform}`);
  }
}

const unexpectedPlatforms = Object.keys(manifest.platforms).filter(
  (platform) => !requiredPlatforms.includes(platform),
);
if (unexpectedPlatforms.length > 0) {
  throw new Error(`manifest contains platforms outside this build: ${unexpectedPlatforms.join(', ')}`);
}

console.log(`verified updater manifest ${manifest.version}: ${requiredPlatforms.join(', ')}`);

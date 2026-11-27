// Generate a single updater manifest for a release.
//
// Inputs (env vars):
//   FLOWIX_MANIFEST_OUT       output file path (overwritten if exists)
//   FLOWIX_VERSION            Flowix version this release advertises
//   FLOWIX_ARTIFACT_PUBLIC_BASE public origin for artifact URLs (no trailing slash)
//   FLOWIX_ARTIFACT_PREFIX     object prefix under which artifacts were uploaded
//   FLOWIX_RELEASE_OUT        artifact staging directory
//   FLOWIX_RELEASE_NOTES      optional human-facing release notes
//   FLOWIX_UPDATE_NOTIFY      whether clients should show update prompts
//
// Inputs (positional argv):
//   <platform>|<artifact-name>   one per built target. Multiple rows may share
//                                the same `platform` (e.g. darwin-aarch64 and
//                                darwin-x86_64 both belong to the macos group).
//
// `platforms` only ever contains the rows we received. This is what makes
// partial releases safe: each platform's updater hits a manifest whose top-
// level `version` matches the artifact's actual version. The artifact and its
// adjacent `.sig` file are the signed Flowix updater package; DSH is not part
// of this manifest or signing flow.

import fs from 'node:fs';
import path from 'node:path';

const out = process.env.FLOWIX_MANIFEST_OUT;
const version = process.env.FLOWIX_VERSION;
const publicBase = process.env.FLOWIX_ARTIFACT_PUBLIC_BASE?.replace(/\/$/u, '');
const prefix = process.env.FLOWIX_ARTIFACT_PREFIX?.replace(/^\/+|\/+$/gu, '');
const releaseOut = process.env.FLOWIX_RELEASE_OUT;
const releaseNotes = process.env.FLOWIX_RELEASE_NOTES?.trim() || `Flowix ${version}`;
const notifyValue = process.env.FLOWIX_UPDATE_NOTIFY?.trim().toLowerCase() || 'true';
const rows = process.argv.slice(1);

if (!out || !version || !publicBase || prefix === undefined || !releaseOut) {
  throw new Error('build-updater-manifest: FLOWIX_MANIFEST_OUT, FLOWIX_VERSION, FLOWIX_ARTIFACT_PUBLIC_BASE, FLOWIX_ARTIFACT_PREFIX, and FLOWIX_RELEASE_OUT are required');
}
if (notifyValue !== 'true' && notifyValue !== 'false') {
  throw new Error('build-updater-manifest: FLOWIX_UPDATE_NOTIFY must be true or false');
}

const platforms = {};
for (const row of rows) {
  const separator = row.indexOf('|');
  if (separator < 0) continue;
  const platform = row.slice(0, separator);
  const name = row.slice(separator + 1);
  const artifact = path.join(releaseOut, name);
  if (!fs.existsSync(artifact)) {
    throw new Error(`build-updater-manifest: artifact is missing: ${artifact}`);
  }
  const signaturePath = `${artifact}.sig`;
  if (!fs.existsSync(signaturePath)) {
    throw new Error(`build-updater-manifest: updater signature is missing: ${signaturePath}`);
  }
  platforms[platform] = {
    url: `${publicBase}/${prefix}/${name}`,
    signature: fs.readFileSync(signaturePath, 'utf8').trim(),
  };
}

const manifest = {
  version,
  notify: notifyValue === 'true',
  notes: releaseNotes,
  pub_date: new Date().toISOString(),
  platforms,
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`==> wrote ${path.relative(process.cwd(), out)}`);

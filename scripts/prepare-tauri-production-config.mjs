import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(repoRoot, "app", "flowix-desktop", "tauri.conf.production.json");
const outputPath = path.join(repoRoot, "app", "flowix-desktop", "tauri.conf.production.local.json");

const allowUnsigned = process.env.FLOWIX_ALLOW_UNSIGNED === "1";
const config = JSON.parse(fs.readFileSync(sourcePath, "utf8"));

function stripCommentKeys(value) {
  if (Array.isArray(value)) {
    return value.map(stripCommentKeys);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith("_"))
        .map(([key, child]) => [key, stripCommentKeys(child)]),
    );
  }
  return value;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value && !allowUnsigned) {
    throw new Error(`${name} is required for a signed production build. Set FLOWIX_ALLOW_UNSIGNED=1 only for local unsigned packages.`);
  }
  return value;
}

const production = stripCommentKeys(config);
production.bundle ??= {};

if (process.platform === "win32") {
  production.bundle.targets = ["nsis"];
  production.bundle.windows ??= {};
  if (production.bundle.macOS) {
    delete production.bundle.macOS.signingIdentity;
    delete production.bundle.macOS.providerShortName;
  }
  const thumbprint = requiredEnv("WINDOWS_CERT_THUMBPRINT");
  if (thumbprint) {
    production.bundle.windows.certificateThumbprint = thumbprint;
  } else {
    delete production.bundle.windows.certificateThumbprint;
  }
  production.bundle.windows.digestAlgorithm = "sha256";
  production.bundle.windows.timestampUrl = process.env.WINDOWS_TIMESTAMP_URL || "http://timestamp.sectigo.com";
} else if (process.platform === "darwin") {
  production.bundle.targets = ["dmg"];
  production.bundle.macOS ??= {};
  if (production.bundle.windows) {
    delete production.bundle.windows.certificateThumbprint;
  }
  const signingIdentity = requiredEnv("APPLE_SIGNING_IDENTITY");
  const teamId = requiredEnv("APPLE_TEAM_ID");
  if (signingIdentity) {
    production.bundle.macOS.signingIdentity = signingIdentity;
  } else {
    delete production.bundle.macOS.signingIdentity;
  }
  if (teamId) {
    production.bundle.macOS.providerShortName = teamId;
  } else {
    delete production.bundle.macOS.providerShortName;
  }
  production.bundle.macOS.entitlements = "entitlements.plist";
  production.bundle.macOS.hardenedRuntime = true;
} else {
  if (production.bundle.windows) {
    delete production.bundle.windows.certificateThumbprint;
  }
  if (production.bundle.macOS) {
    delete production.bundle.macOS.signingIdentity;
    delete production.bundle.macOS.providerShortName;
  }
}

fs.writeFileSync(outputPath, `${JSON.stringify(production, null, 2)}\n`);
console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);

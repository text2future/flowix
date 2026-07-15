import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tauriDir = path.join(repoRoot, "app", "flowix-desktop");
const baseConfigPath = path.join(tauriDir, "tauri.conf.json");
const productionConfigPath = path.join(tauriDir, "tauri.conf.production.json");
const platformArgIndex = process.argv.indexOf("--platform");
const targetPlatform =
  platformArgIndex >= 0 ? process.argv[platformArgIndex + 1] : process.platform;

const allowUnsigned = process.env.FLOWIX_ALLOW_UNSIGNED === "1";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

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

function mergeConfig(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  if (!base || typeof base !== "object" || !override || typeof override !== "object") {
    return override === undefined ? base : override;
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = mergeConfig(base[key], value);
  }
  return merged;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value && !allowUnsigned) {
    throw new Error(`${name} is required for a signed production build. Set FLOWIX_ALLOW_UNSIGNED=1 only for local unsigned packages.`);
  }
  return value;
}

const base = stripCommentKeys(readJson(baseConfigPath));
const productionOverride = stripCommentKeys(readJson(productionConfigPath));
let platformOverride = {};
let outputPath;

if (targetPlatform === "win32") {
  platformOverride = stripCommentKeys(readJson(path.join(tauriDir, "tauri.windows.conf.json")));
  outputPath = path.join(tauriDir, "tauri.windows.production.local.json");
} else if (targetPlatform === "darwin") {
  platformOverride = stripCommentKeys(readJson(path.join(tauriDir, "tauri.macos.conf.json")));
  outputPath = path.join(tauriDir, "tauri.macos.production.local.json");
} else {
  outputPath = path.join(tauriDir, "tauri.production.local.json");
}

const production = mergeConfig(mergeConfig(base, platformOverride), productionOverride);
production.bundle ??= {};

if (targetPlatform === "win32") {
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
  const mainWindow = production.app?.windows?.[0];
  if (!mainWindow || mainWindow.visible !== false || mainWindow.decorations !== false) {
    throw new Error("Invalid Windows production config: main window must set visible=false and decorations=false.");
  }
} else if (targetPlatform === "darwin") {
  production.bundle.targets = ["app", "dmg"];
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
console.log(path.relative(repoRoot, outputPath));

import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const platformArgIndex = process.argv.indexOf("--platform");
const targetPlatform =
  platformArgIndex >= 0 ? process.argv[platformArgIndex + 1] : process.platform;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
    shell: process.platform === "win32",
    env: process.env,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  return result.stdout?.trim();
}

run("npm", ["run", "cli:build"]);

const configPath = run(
  "node",
  ["scripts/prepare-tauri-production-config.mjs", "--platform", targetPlatform],
  { capture: true },
);

if (!configPath) {
  throw new Error("Production config generator did not return a config path.");
}

run("tauri", ["build", "--config", configPath]);

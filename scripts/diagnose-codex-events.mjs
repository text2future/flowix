#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_PROMPT =
  "Reply with exactly: FLOWIX_CODEX_EVENT_DIAGNOSTIC_OK";

function parseArgs(argv) {
  const args = {
    cwd: process.cwd(),
    outDir: path.join(process.cwd(), "tmp", "codex-event-diagnostics"),
    prompt: DEFAULT_PROMPT,
    addDir: [],
    timeoutMs: 120000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    switch (arg) {
      case "--prompt":
        args.prompt = next();
        break;
      case "--prompt-file":
        args.prompt = readFileSync(next(), "utf8");
        break;
      case "--cwd":
        args.cwd = next();
        break;
      case "--out-dir":
        args.outDir = next();
        break;
      case "--resume":
        args.resume = next();
        break;
      case "--model":
        args.model = next();
        break;
      case "--reasoning-effort":
        args.reasoningEffort = next();
        break;
      case "--permission-mode":
        args.permissionMode = next();
        break;
      case "--add-dir":
        args.addDir.push(next());
        break;
      case "--timeout-ms":
        args.timeoutMs = Number(next());
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/diagnose-codex-events.mjs [options]

Options:
  --prompt <text>              Prompt sent to codex stdin.
  --prompt-file <path>         Read prompt from a file.
  --cwd <path>                 Working directory. Default: current directory.
  --out-dir <path>             Output directory. Default: tmp/codex-event-diagnostics.
  --resume <session-id>        Run "codex exec resume <session-id> -".
  --model <model>              Pass "-m <model>".
  --reasoning-effort <level>   Pass "-c model_reasoning_effort=\\"<level>\\"".
  --permission-mode <mode>     New sessions only: --sandbox <mode>.
  --add-dir <path>             New sessions only: pass extra --add-dir. Repeatable.
  --timeout-ms <ms>            Kill process after timeout. Default: 120000.

Environment:
  CODEX_CLI_PATH               Override codex executable.
  CODEX_NODE_PATH              Node binary used when CODEX_CLI_PATH points at a .js file.
`);
}

function resolveCodexBinary() {
  const envPath = process.env.CODEX_CLI_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  if (process.platform === "win32") {
    const npmShim = path.join(homedir(), "AppData", "Roaming", "npm", "codex.cmd");
    if (existsSync(npmShim)) return npmShim;
    return "codex.cmd";
  }
  return "codex";
}

function resolveNodeBinary() {
  const envPath = process.env.CODEX_NODE_PATH;
  if (envPath && existsSync(envPath)) return envPath;
  return "node";
}

function buildCodexCommand(args) {
  const codex = resolveCodexBinary();
  const real = existsSync(codex) ? realpathSync(codex) : codex;
  const cmdShimJs = path.join(path.dirname(real), "node_modules", "@openai", "codex", "bin", "codex.js");
  const jsEntrypoint =
    path.extname(real) === ".js"
      ? real
      : process.platform === "win32" && [".cmd", ".bat"].includes(path.extname(real).toLowerCase()) && existsSync(cmdShimJs)
        ? cmdShimJs
        : null;
  const command = jsEntrypoint ? resolveNodeBinary() : codex;
  const commandArgs = jsEntrypoint ? [jsEntrypoint] : [];
  const shell = false;

  if (args.resume) {
    commandArgs.push("exec", "resume");
    appendModel(commandArgs, args.model);
    appendReasoning(commandArgs, args.reasoningEffort);
    commandArgs.push("--json", "--skip-git-repo-check", args.resume, "-");
  } else {
    commandArgs.push("exec");
    appendPermission(commandArgs, args.permissionMode);
    appendModel(commandArgs, args.model);
    appendReasoning(commandArgs, args.reasoningEffort);
    commandArgs.push("--json", "--skip-git-repo-check", "-C", args.cwd);
    for (const extra of args.addDir) {
      commandArgs.push("--add-dir", extra);
    }
  }

  return { command, commandArgs, resolvedCodex: codex, realCodex: real, shell };
}

function appendModel(argv, model) {
  if (model && model.trim() && model.trim() !== "inherit") {
    argv.push("-m", model.trim());
  }
}

function appendReasoning(argv, effort) {
  if (["low", "medium", "high", "xhigh"].includes(String(effort || "").trim())) {
    argv.push("-c", `model_reasoning_effort="${effort.trim()}"`);
  }
}

function appendPermission(argv, mode) {
  if (["read-only", "workspace-write", "danger-full-access"].includes(String(mode || "").trim())) {
    argv.push("--sandbox", mode.trim());
  }
}

function classifyEvent(value) {
  const top = stringAt(value, ["type"]) || stringAt(value, ["kind"]) || "unknown";
  const payloadType =
    stringAt(value, ["payload", "type"]) ||
    stringAt(value, ["item", "type"]) ||
    stringAt(value, ["payload", "item", "type"]) ||
    "";
  return payloadType ? `${top}:${payloadType}` : top;
}

function stringAt(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

function firstString(value, paths) {
  for (const keys of paths) {
    const found = stringAt(value, keys);
    if (found) return found;
  }
  return undefined;
}

function extractSessionId(value) {
  for (const key of ["session_id", "sessionId", "conversation_id", "conversationId", "thread_id", "threadId"]) {
    if (typeof value?.[key] === "string") return value[key];
  }
  const eventType = String(value?.type || value?.kind || "");
  if (eventType.includes("session") && typeof value?.id === "string") return value.id;
  return findNestedSessionId(value);
}

function findNestedSessionId(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedSessionId(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["session_id", "sessionId", "thread_id", "threadId"]) {
    if (typeof value[key] === "string") return value[key];
  }
  for (const nested of Object.values(value)) {
    const found = findNestedSessionId(nested);
    if (found) return found;
  }
  return undefined;
}

function collectInteresting(value, index, line) {
  const eventKey = classifyEvent(value);
  const entry = { index, event: eventKey };
  const text = firstString(value, [
    ["payload", "message"],
    ["payload", "text"],
    ["payload", "content"],
    ["item", "content"],
    ["payload", "item", "content"],
  ]);
  if (text) entry.text = text.slice(0, 500);

  const name = firstString(value, [
    ["payload", "name"],
    ["item", "name"],
    ["payload", "item", "name"],
  ]);
  if (name) entry.name = name;

  const usage = value?.payload?.usage || value?.payload?.token_usage || value?.payload;
  if (eventKey === "event_msg:token_count" && usage && typeof usage === "object") {
    entry.usage = {
      input_tokens: usage.input_tokens,
      cached_input_tokens: usage.cached_input_tokens,
      output_tokens: usage.output_tokens,
      reasoning_output_tokens: usage.reasoning_output_tokens,
      total_tokens: usage.total_tokens,
    };
  }

  const sessionId = extractSessionId(value);
  if (sessionId) entry.sessionId = sessionId;

  entry.rawLine = line;
  return entry;
}

function toMarkdown(report) {
  const lines = [];
  lines.push("# Codex Event Diagnostic");
  lines.push("");
  lines.push(`- command: \`${report.commandLine}\``);
  lines.push(`- cwd: \`${report.cwd}\``);
  lines.push(`- exit: ${report.exitCode === null ? "timeout/unknown" : report.exitCode}`);
  lines.push(`- stdout lines: ${report.stdoutLines}`);
  lines.push(`- json lines: ${report.jsonLines}`);
  lines.push(`- non-json lines: ${report.nonJsonLines}`);
  lines.push(`- stderr chars: ${report.stderr.length}`);
  lines.push(`- saw task_complete: ${report.sawTaskComplete}`);
  lines.push("");
  lines.push("## Event Counts");
  lines.push("");
  for (const [key, count] of Object.entries(report.counts).sort()) {
    lines.push(`- ${key}: ${count}`);
  }
  lines.push("");
  lines.push("## Session Ids");
  lines.push("");
  for (const id of report.sessionIds) lines.push(`- ${id}`);
  if (report.sessionIds.length === 0) lines.push("- none");
  lines.push("");
  lines.push("## Interesting Events");
  lines.push("");
  for (const item of report.interesting) {
    const bits = [`${item.index}`, item.event];
    if (item.sessionId) bits.push(`session=${item.sessionId}`);
    if (item.name) bits.push(`name=${item.name}`);
    lines.push(`- ${bits.join(" | ")}`);
    if (item.text) lines.push(`  text: ${JSON.stringify(item.text)}`);
    if (item.usage) lines.push(`  usage: ${JSON.stringify(item.usage)}`);
  }
  lines.push("");
  lines.push("## Stderr Preview");
  lines.push("");
  lines.push("```");
  lines.push(report.stderr.slice(0, 4000));
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rawPath = path.join(args.outDir, `${stamp}.raw.jsonl`);
  const nonJsonPath = path.join(args.outDir, `${stamp}.non-json.log`);
  const reportJsonPath = path.join(args.outDir, `${stamp}.report.json`);
  const reportMdPath = path.join(args.outDir, `${stamp}.report.md`);
  const stdoutRaw = createWriteStream(rawPath, { flags: "w" });
  const nonJsonRaw = createWriteStream(nonJsonPath, { flags: "w" });

  const commandInfo = buildCodexCommand(args);
  const child = spawn(commandInfo.command, commandInfo.commandArgs, {
    cwd: args.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: commandInfo.shell,
  });

  const report = {
    cwd: args.cwd,
    command: commandInfo.command,
    commandArgs: commandInfo.commandArgs,
    shell: commandInfo.shell,
    resolvedCodex: commandInfo.resolvedCodex,
    realCodex: commandInfo.realCodex,
    commandLine: [commandInfo.command, ...commandInfo.commandArgs].map((part) => JSON.stringify(part)).join(" "),
    promptChars: args.prompt.length,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    stdoutLines: 0,
    jsonLines: 0,
    nonJsonLines: 0,
    counts: {},
    sessionIds: [],
    sawTaskComplete: false,
    interesting: [],
    stderr: "",
  };
  const sessionIds = new Set();

  const timeout = setTimeout(() => {
    report.timedOut = true;
    child.kill();
  }, args.timeoutMs);

  child.stdin.end(args.prompt);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    report.stderr += chunk;
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    report.stdoutLines += 1;
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const value = JSON.parse(trimmed);
      report.jsonLines += 1;
      stdoutRaw.write(`${trimmed}\n`);
      const key = classifyEvent(value);
      report.counts[key] = (report.counts[key] || 0) + 1;
      if (key === "event_msg:task_complete" || key === "turn.completed" || key === "turn.failed") {
        report.sawTaskComplete = true;
      }
      const sessionId = extractSessionId(value);
      if (sessionId) sessionIds.add(sessionId);
      const interesting =
        key === "event_msg:agent_message" ||
        key === "event_msg:token_count" ||
        key === "event_msg:task_started" ||
        key === "event_msg:task_complete" ||
        key === "thread.started" ||
        key === "turn.started" ||
        key === "turn.completed" ||
        key === "turn.failed" ||
        key === "item.completed" ||
        key === "item.updated" ||
        key === "error" ||
        key === "turn_context" ||
        key.startsWith("response_item:") ||
        key === "session_meta" ||
        key === "compacted";
      if (interesting) {
        report.interesting.push(collectInteresting(value, report.stdoutLines, trimmed));
      }
    } catch {
      report.nonJsonLines += 1;
      nonJsonRaw.write(`${line}\n`);
    }
  });

  await new Promise((resolve) => {
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      report.exitCode = code;
      report.signal = signal;
      report.endedAt = new Date().toISOString();
      resolve();
    });
  });

  stdoutRaw.end();
  nonJsonRaw.end();
  report.sessionIds = [...sessionIds];
  writeFileSync(reportJsonPath, JSON.stringify(report, null, 2), "utf8");
  writeFileSync(reportMdPath, toMarkdown(report), "utf8");

  console.log(`raw_jsonl=${rawPath}`);
  console.log(`non_json=${nonJsonPath}`);
  console.log(`report_json=${reportJsonPath}`);
  console.log(`report_md=${reportMdPath}`);
  console.log(`exit=${report.exitCode} timed_out=${report.timedOut} task_complete=${report.sawTaskComplete}`);
  console.log(`json_lines=${report.jsonLines} non_json_lines=${report.nonJsonLines}`);
  console.log("event_counts=");
  for (const [key, count] of Object.entries(report.counts).sort()) {
    console.log(`  ${key}: ${count}`);
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});

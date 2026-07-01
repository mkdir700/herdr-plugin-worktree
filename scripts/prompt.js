#!/usr/bin/env node
"use strict";

// Overlay flow for "start a worktree from a GitHub issue":
//   1. ask for an issue (URL / #number / "issue 614") and an agent
//   2. `gh issue view` -> { number, title, body, labels, url }
//   3. `claude -p` drafts { branch, workspace } from that content
//      (deterministic `issue-<n>-<title-slug>` fallback if that fails)
//   4. `herdr worktree create --branch <branch> --label <workspace>`
//   5. start the agent in the worktree's root pane, seeded with the issue
//
// herdr injects HERDR_PLUGIN_CONTEXT_JSON (the focused item) plus the usual
// HERDR_PLUGIN_* dirs. We resolve the repo root from that context.

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");
const { spawn, spawnSync } = require("node:child_process");

const herdr = process.env.HERDR_BIN_PATH || "herdr";
const pluginRoot = process.env.HERDR_PLUGIN_ROOT || __dirname;
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR || pluginRoot;
const context = readJson(process.env.HERDR_PLUGIN_CONTEXT_JSON) || {};

const defaultConfig = {
  defaultAgent: "claude",
  agents: {
    claude: { command: "claude" },
    codex: { command: "codex" },
  },
  baseRef: "",
  namingModel: "",
  promptTemplate:
    "Work on this GitHub issue: {url}\n\nTitle: {title}\n\nRead the issue with `gh issue view {number}`, then propose a short plan before changing code.",
  prPromptTemplate:
    "Continue work on this pull request: {url}\n\nTitle: {title}\nBranch: {branch}\n\nRead it with `gh pr view {number}` and `gh pr diff {number}`, then propose a short plan before changing code.",
  branchPromptTemplate:
    "You are on branch {branch} (imported from origin). Review the recent changes with `git log` / `git diff`, then propose a short plan before changing code.",
  timing: {
    // Settle time AFTER the agent is detected `idle` before pasting the prompt,
    // so a TUI (e.g. claude) has finished drawing its input box. herdr reports
    // `idle` as soon as it detects the agent process (~0.5s), ~1.5s before the
    // box is actually ready, so this must comfortably exceed that gap. Bump it
    // on slower machines if the initial prompt still gets dropped.
    afterAgentStartMs: 2500,
    afterPromptMs: 600, // gap between pasting the prompt and pressing Enter
    afterOverlayCloseFocusMs: 400,
    setupTimeoutMs: 600000, // cap on how long .superset setup may block the agent
    agentReadyTimeoutMs: 30000, // cap on waiting for the agent to be detected idle
  },
};

// ---------------------------------------------------------------- utilities

function readJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`failed to read ${file}: ${error.message}`);
  }
}

function seedConfigFile() {
  const target = path.join(configDir, "config.json");
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(configDir, { recursive: true });
  const example = path.join(pluginRoot, "config.example.json");
  const content = fs.existsSync(example)
    ? fs.readFileSync(example, "utf8")
    : `${JSON.stringify(defaultConfig, null, 2)}\n`;
  fs.writeFileSync(target, content, "utf8");
  return target;
}

function mergeConfig(base, override) {
  if (!override || typeof override !== "object") return base;
  const merged = { ...base, ...override };
  merged.agents = { ...base.agents, ...(override.agents || {}) };
  merged.timing = { ...base.timing, ...(override.timing || {}) };
  return merged;
}

function loadConfig() {
  return mergeConfig(defaultConfig, readJsonFile(seedConfigFile()));
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function runHerdr(args, options = {}) {
  const result = run(herdr, args, options);
  if (result.error) throw new Error(`${herdr} ${args.join(" ")} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(`${herdr} ${args.join(" ")} failed: ${msg}`);
  }
  return result.stdout;
}

function runHerdrJson(args) {
  const stdout = runHerdr(args);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${herdr} ${args.join(" ")} returned non-JSON: ${stdout.trim()}`);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function renderTemplate(template, values) {
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) =>
    values[key] === undefined || values[key] === null ? "" : String(values[key]),
  );
}

// Focus the new workspace once the overlay has closed (mirrors github-start).
function focusWorkspaceAfterOverlayCloses(workspaceId, delayMs) {
  const code = `
    const { spawnSync } = require("node:child_process");
    const delay = Number(process.argv[3] || "400");
    setTimeout(() => {
      spawnSync(process.argv[1], ["workspace", "focus", process.argv[2]], { stdio: "ignore" });
    }, delay);
  `;
  const child = spawn(process.execPath, ["-e", code, herdr, workspaceId, String(delayMs)], {
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.unref();
}

// ---------------------------------------------------------------- reference parsing

// Classify the overlay input into one of three kinds:
//   issue  -> read the issue, draft fresh branch/workspace names, create a new
//             branch + worktree (the original flow)
//   pr     -> import the PR's existing (remote) head branch into a worktree
//   branch -> import a raw remote branch name into a worktree
// A bare "#614"/"614" is ambiguous (issue vs PR share the number space), so it
// comes back as "unknown" and resolveKind() probes `gh pr view` to decide.
function parseRef(raw) {
  const item = String(raw || "").trim();
  if (!item) return null;

  // Full GitHub URL — /pull/ vs /issues/ states the kind outright.
  const url = item.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/(issues|pull)\/([0-9]+)/i);
  if (url) {
    return {
      kind: url[3].toLowerCase() === "pull" ? "pr" : "issue",
      owner: url[1],
      repo: url[2],
      number: url[4],
      url: item.startsWith("http") ? item : `https://${item}`,
    };
  }

  // Explicit keyword prefix: "pr 614", "pull #614", "issue 614".
  const pr = item.match(/^(?:pr|pull)[\s#-]*([0-9]+)$/i);
  if (pr) return { kind: "pr", owner: "", repo: "", number: pr[1], url: "" };
  const iss = item.match(/^issue[\s#-]*([0-9]+)$/i);
  if (iss) return { kind: "issue", owner: "", repo: "", number: iss[1], url: "" };

  // Bare number / "#614" — could be either; resolveKind() decides.
  const num = item.match(/^#?([0-9]+)$/);
  if (num) return { kind: "unknown", owner: "", repo: "", number: num[1], url: "" };

  // Otherwise treat it as a remote branch name to import (e.g. "feature/login"
  // or "origin/feature/login").
  if (/^[\w.][\w.\-/]*$/.test(item)) {
    return { kind: "branch", owner: "", repo: "", number: "", url: "", branch: item.replace(/^origin\//, "") };
  }
  return null;
}

// A given number is an issue OR a PR, never both, so a successful `gh pr view`
// is conclusive. Used only for the ambiguous bare-number case.
function resolveKind(ref, cwd) {
  if (ref.kind !== "unknown") return ref.kind;
  const args = ["pr", "view", ref.number, "--json", "number"];
  if (ref.owner && ref.repo) args.push("--repo", `${ref.owner}/${ref.repo}`);
  const probe = run("gh", args, { cwd });
  return probe.status === 0 ? "pr" : "issue";
}

// Pull issue content. When owner/repo are known use --repo; otherwise rely on
// gh detecting the repo from the worktree cwd.
function fetchIssue(ref, cwd) {
  const args = ["issue", "view", ref.number, "--json", "number,title,body,labels,url"];
  if (ref.owner && ref.repo) args.push("--repo", `${ref.owner}/${ref.repo}`);
  const result = run("gh", args, { cwd });
  if (result.error) throw new Error(`gh failed to start (is it installed?): ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`gh issue view ${ref.number} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  const data = JSON.parse(result.stdout);
  return {
    number: String(data.number),
    title: data.title || "",
    body: data.body || "",
    labels: Array.isArray(data.labels) ? data.labels.map((l) => l.name).filter(Boolean) : [],
    url: data.url || ref.url || "",
  };
}

// Pull PR metadata, including the head branch name we'll import.
function fetchPr(ref, cwd) {
  const args = ["pr", "view", ref.number, "--json", "number,title,body,url,headRefName,isCrossRepository"];
  if (ref.owner && ref.repo) args.push("--repo", `${ref.owner}/${ref.repo}`);
  const result = run("gh", args, { cwd });
  if (result.error) throw new Error(`gh failed to start (is it installed?): ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`gh pr view ${ref.number} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  const data = JSON.parse(result.stdout);
  return {
    number: String(data.number),
    title: data.title || "",
    body: data.body || "",
    url: data.url || ref.url || "",
    headRefName: data.headRefName || "",
    crossRepository: !!data.isCrossRepository,
  };
}

// ---------------------------------------------------------------- naming

function slugify(value, max = 50) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

function sanitizeBranch(value, number) {
  let slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
    .slice(0, 60)
    .replace(/[-/]+$/g, "");
  if (!slug) slug = `issue-${number}`;
  return slug;
}

function compactLabel(value, fallback) {
  const label = String(value || "").replace(/\s+/g, " ").trim().slice(0, 40);
  return label || fallback;
}

// Deterministic names from the title alone — used when claude is unavailable
// or returns garbage.
function fallbackNames(issue) {
  const titleSlug = slugify(issue.title, 40);
  const branch = sanitizeBranch(titleSlug ? `${issue.number}-${titleSlug}` : `issue-${issue.number}`, issue.number);
  const workspace = compactLabel(issue.title, `issue-${issue.number}`);
  return { branch, workspace };
}

// Ask claude to draft { branch, workspace } from the issue content. Returns the
// fallback (and logs why) on any failure — naming must never block the flow.
function draftNames(issue, config) {
  const fallback = fallbackNames(issue);
  const claudeBin = config.agents?.claude?.command || "claude";
  const body = issue.body.length > 1800 ? `${issue.body.slice(0, 1800)}\n...[truncated]` : issue.body;
  const prompt = [
    "You name a git branch and a herdr workspace for work on a GitHub issue.",
    `Issue #${issue.number}: ${issue.title}`,
    issue.labels.length ? `Labels: ${issue.labels.join(", ")}` : "",
    "Body:",
    body || "(empty)",
    "",
    "Reply with ONLY a JSON object, no markdown fence, no prose:",
    '{"branch": "<git branch>", "workspace": "<short label>"}',
    `branch: lowercase kebab-case, prefixed with the issue number, <=50 chars, e.g. "${issue.number}-fix-login-redirect".`,
    "workspace: a short human-readable label, <=40 chars.",
  ]
    .filter(Boolean)
    .join("\n");

  const args = ["-p"];
  if (config.namingModel) args.push("--model", config.namingModel);
  args.push(prompt);

  const result = run(typeof claudeBin === "string" ? claudeBin : "claude", args, { timeout: 90_000 });
  if (result.error || result.status !== 0 || !result.stdout) {
    output.write("  (claude naming unavailable; using title-based fallback)\n");
    return fallback;
  }
  const match = result.stdout.match(/\{[\s\S]*\}/);
  const parsed = match ? readJson(match[0]) : null;
  if (!parsed || (!parsed.branch && !parsed.workspace)) {
    output.write("  (could not parse claude output; using title-based fallback)\n");
    return fallback;
  }
  return {
    branch: sanitizeBranch(parsed.branch || fallback.branch, issue.number),
    workspace: compactLabel(parsed.workspace || fallback.workspace, fallback.workspace),
  };
}

// ---------------------------------------------------------------- worktree

// Base ref for the new branch: explicit config.baseRef wins, else the repo's
// default branch (origin/HEAD), else the first of main/master/develop that
// exists, else null — null lets herdr branch off the current HEAD. Mirrors the
// tuicr-diff plugin's detect_base so the two behave consistently.
function detectBaseRef(cwd, config) {
  if (config.baseRef) return config.baseRef;
  const sym = run("git", ["-C", cwd, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (sym.status === 0 && sym.stdout.trim()) {
    return sym.stdout.trim().replace(/^refs\/remotes\//, ""); // refs/remotes/origin/main -> origin/main
  }
  for (const b of ["main", "master", "develop"]) {
    const local = run("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`]);
    if (local.status === 0) return b;
    const remote = run("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`]);
    if (remote.status === 0) return `origin/${b}`;
  }
  return null;
}

// worktree.create response shape isn't guaranteed across fields, so probe a few
// likely paths for the new workspace id, then list its panes for the root pane.
function extractIds(response) {
  const r = response?.result || {};
  const workspaceId =
    r.worktree?.open_workspace_id ||
    r.open_workspace_id ||
    r.workspace?.workspace_id ||
    r.workspace_id ||
    null;
  const paneId = r.root_pane?.pane_id || r.worktree?.root_pane?.pane_id || r.pane?.pane_id || null;
  return { workspaceId, paneId };
}

function rootPaneOf(workspaceId) {
  const data = runHerdrJson(["pane", "list", "--workspace", workspaceId]);
  const panes = data?.result?.panes || [];
  const focused = panes.find((p) => p.focused) || panes[0];
  return focused?.pane_id || null;
}

function branchExistsLocally(branch, cwd) {
  return run("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
}

// Make a local branch at the PR's head. `pull/<n>/head` is exposed on the base
// repo's origin for every PR, so this works for fork PRs too without adding a
// remote. If the branch already exists locally we leave it untouched (don't
// clobber any local work) and just reuse it.
function importPrBranch(pr, cwd) {
  const branch = pr.headRefName || `pr-${pr.number}`;
  if (branchExistsLocally(branch, cwd)) {
    output.write(`  (local branch ${branch} already exists; reusing it)\n`);
    return branch;
  }
  const fetch = run("git", ["-C", cwd, "fetch", "origin", `pull/${pr.number}/head:${branch}`]);
  if (fetch.status !== 0) {
    throw new Error(`git fetch pull/${pr.number}/head failed: ${(fetch.stderr || fetch.stdout || "").trim()}`);
  }
  return branch;
}

// Make a local branch tracking a raw remote branch name.
function importRemoteBranch(branch, cwd) {
  if (branchExistsLocally(branch, cwd)) {
    output.write(`  (local branch ${branch} already exists; reusing it)\n`);
    return branch;
  }
  const fetch = run("git", ["-C", cwd, "fetch", "origin", `${branch}:${branch}`]);
  if (fetch.status !== 0) {
    throw new Error(`git fetch origin ${branch} failed: ${(fetch.stderr || fetch.stdout || "").trim()}`);
  }
  return branch;
}

function repoRootOf(cwd) {
  const r = run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  return r.status === 0 ? r.stdout.trim() : cwd;
}

// Where herdr keeps this repo's linked worktrees. herdr lays them out as
// <worktrees_dir>/<repo>/<slug>, so an existing linked worktree whose PARENT is
// named after the repo pins the real (possibly user-configured) worktrees dir.
// We match on that shape specifically to avoid inheriting some other tool's
// out-of-tree checkout location (e.g. an external-disk worktree). Fall back to
// herdr's default ~/.herdr/worktrees/<repo> when none matches; `worktree open
// --path` accepts any valid path, so an approximate location is still harmless.
function worktreeParentDir(cwd) {
  const root = repoRootOf(cwd);
  const repoName = path.basename(root);
  const list = run("git", ["-C", cwd, "worktree", "list", "--porcelain"]);
  if (list.status === 0) {
    for (const line of list.stdout.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const p = line.slice("worktree ".length).trim();
      if (!p || path.resolve(p) === path.resolve(root)) continue;
      if (path.basename(path.dirname(p)) === repoName) return path.dirname(p);
    }
  }
  const home = process.env.HOME || require("node:os").homedir();
  return path.join(home, ".herdr", "worktrees", repoName);
}

// git allows "/" in branch names; herdr flattens those to "-" for the checkout
// dir (feature/x -> feature-x). Mirror that so imported worktrees sit alongside
// herdr's own with matching names.
function branchDirSlug(branch) {
  return String(branch).replace(/\//g, "-");
}

function uniqueDir(parent, slug) {
  let dir = path.join(parent, slug);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(parent, `${slug}-${n}`);
  return dir;
}

// Path of the git worktree already checked out on `branch`, if any.
function worktreePathForBranch(branch, cwd) {
  const list = run("git", ["-C", cwd, "worktree", "list", "--porcelain"]);
  if (list.status !== 0) return null;
  let cur = null;
  for (const line of list.stdout.split("\n")) {
    if (line.startsWith("worktree ")) cur = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch ") && line.slice("branch ".length).trim() === `refs/heads/${branch}`) {
      return cur;
    }
  }
  return null;
}

// Materialize an on-disk git worktree for an EXISTING local branch, returning
// its path. herdr's `worktree create` always makes a *new* branch (it fails if
// the branch already exists) and `worktree open` only adopts a worktree that
// already exists on disk — so neither can check out a pre-existing branch on its
// own. The import flows therefore drive plain `git worktree add` here.
function ensureWorktreeCheckout(branch, cwd) {
  const existing = worktreePathForBranch(branch, cwd);
  if (existing) {
    output.write(`  (branch ${branch} already checked out at ${existing}; reusing it)\n`);
    return existing;
  }
  const parent = worktreeParentDir(cwd);
  fs.mkdirSync(parent, { recursive: true });
  const dir = uniqueDir(parent, branchDirSlug(branch));
  const add = run("git", ["-C", cwd, "worktree", "add", dir, branch]);
  if (add.status !== 0) {
    throw new Error(`git worktree add ${dir} ${branch} failed: ${(add.stderr || add.stdout || "").trim()}`);
  }
  return dir;
}

// Open an existing local branch as a worktree (used for imported PR/branch
// flows; the issue flow uses `worktree create` to make a fresh branch instead).
// We materialize the checkout on disk first, then adopt it by --path, because
// `worktree open --branch` only finds a worktree that already exists.
function openWorktree(branch, label, cwd) {
  const dir = ensureWorktreeCheckout(branch, cwd);
  return runHerdrJson([
    "worktree",
    "open",
    "--cwd",
    cwd,
    "--path",
    dir,
    "--label",
    label,
    "--focus",
    "--json",
  ]);
}

// The new worktree's checkout path, from whichever field the response carries.
function checkoutPathOf(response) {
  const r = response?.result || {};
  return (
    r.worktree?.path ||
    r.worktree?.checkout_path ||
    r.workspace?.worktree?.checkout_path ||
    r.root_pane?.cwd ||
    null
  );
}

// Friendly line printed in the worktree pane once the setup chain finishes;
// `herdr wait output` matches it to know setup is done. When building the
// printf argument the phrase is split (`'…setup ''complete'`) so the shell's
// ECHO of the typed command never contains the contiguous phrase — only the
// printed OUTPUT does — otherwise `wait output` would match the command echo
// and return before setup actually ran.
const SETUP_DONE_TEXT = ".superset setup complete";

// Run the repo's `.superset/config.json` setup commands directly IN the new
// worktree's root pane (visible + persistent in that pane's scrollback), and
// block until they finish, BEFORE the agent command is typed into the same
// pane. The previous version ran them via spawnSync in this OVERLAY, whose
// output vanished when the overlay closed — so the worktree pane sat blank
// during a long `bun install` and the setup was effectively invisible. Now the
// commands (and their output) show up right where the user ends up working.
// `.superset/config.json` is committed, so it's present in every worktree
// checkout. Best-effort: a missing/malformed config is a no-op, and a slow or
// stuck command only blocks until `setupTimeoutMs` before the agent starts.
function runSupersetSetupInPane(paneId, worktreeDir, config) {
  if (!paneId || !worktreeDir) return;
  let cfg = null;
  try {
    cfg = readJsonFile(path.join(worktreeDir, ".superset", "config.json"));
  } catch {
    cfg = null;
  }
  const cmds = Array.isArray(cfg?.setup)
    ? cfg.setup.filter((c) => typeof c === "string" && c.trim())
    : [];
  if (!cmds.length) return;

  output.write(`\nRunning .superset setup (${cmds.length} command${cmds.length > 1 ? "s" : ""}) in the worktree pane...\n`);
  // Chain the commands with `;` (best-effort: one failing command doesn't stop
  // the rest, matching the old behavior), then print the completion line on its
  // own line, in green. The phrase is split (`'…setup ''complete'`) so the
  // shell's echo of the typed command won't self-match the `wait output` below
  // (see SETUP_DONE_TEXT).
  const [donePrefix, doneSuffix] = SETUP_DONE_TEXT.split(/(?<=setup )/); // ".superset setup " | "complete"
  const line = `${cmds.join("; ")}; printf '\\n\\033[32m✓ %s\\033[0m\\n' '${donePrefix}''${doneSuffix}'`;
  runHerdr(["pane", "run", paneId, line]);
  // Block until the completion line prints (or setupTimeoutMs elapses). Use run()
  // (not runHerdr) so a timeout / non-zero exit never throws and blocks the agent.
  run(herdr, [
    "wait",
    "output",
    paneId,
    "--match",
    SETUP_DONE_TEXT,
    "--source",
    "recent",
    "--timeout",
    String(config.timing.setupTimeoutMs),
  ]);
  output.write(`Setup done.\n`);
}

// Type the initial prompt into the freshly-started agent and submit it.
// `agentCommand` only LAUNCHES the agent; a TUI like claude then needs a second
// or two to draw its input box. herdr marks the pane `idle` the moment it
// DETECTS the agent process (~0.5s) — well before that input box exists — so a
// prompt sent then is silently dropped (the exact "claude started but the seed
// is gone" symptom). So: gate on `idle`, let the UI settle, then PASTE the
// prompt with `send-text` (keeps newlines literal and skips shell expansion of
// the backticks / `$` in the templates — unlike `pane run`) and submit it with
// a single Enter. Best-effort: the idle wait uses run() so a timeout can't throw.
function seedAgentPrompt(paneId, seed, config) {
  run(herdr, [
    "wait",
    "agent-status",
    paneId,
    "--status",
    "idle",
    "--timeout",
    String(config.timing.agentReadyTimeoutMs),
  ]);
  sleep(config.timing.afterAgentStartMs);
  runHerdr(["pane", "send-text", paneId, seed]);
  sleep(config.timing.afterPromptMs);
  runHerdr(["pane", "send-keys", paneId, "enter"]);
}

// Shared tail: run the repo's setup, resolve the root pane, start the agent, seed
// it, and focus the new workspace once the overlay closes. Used by all three kinds.
function launchAgent({ response, branch, agent, config, seedTemplate, seedValues }) {
  let { workspaceId, paneId } = extractIds(response);
  if (!workspaceId) {
    throw new Error(`worktree response had no workspace id. Raw: ${JSON.stringify(response.result || response)}`);
  }
  if (!paneId) paneId = rootPaneOf(workspaceId);
  if (!paneId) throw new Error(`could not resolve a root pane for workspace ${workspaceId}`);

  runHerdr(["pane", "rename", paneId, branch]);
  runSupersetSetupInPane(paneId, checkoutPathOf(response), config);

  output.write(`Starting ${agent} in ${workspaceId}...\n`);
  runHerdr(["pane", "run", paneId, agentCommand(agent, config)]);

  const seed = renderTemplate(seedTemplate, seedValues);
  if (seed.trim()) seedAgentPrompt(paneId, seed, config);

  focusWorkspaceAfterOverlayCloses(workspaceId, config.timing.afterOverlayCloseFocusMs);
  output.write(`\nDone. ${agent} is running in ${workspaceId} on branch ${branch}.\n`);
}

// ---------------------------------------------------------------- main

function normalizeAgent(value, config) {
  const a = String(value || "").trim().toLowerCase();
  if (!a) return "";
  if (a === "c" || a === "cl" || a === "claude") return config.agents.claude ? "claude" : "";
  if (a === "co" || a === "codex") return config.agents.codex ? "codex" : "";
  return config.agents[a] ? a : "";
}

function agentCommand(agent, config) {
  const cmd = config.agents?.[agent]?.command;
  return Array.isArray(cmd) ? cmd.join(" ") : String(cmd || agent);
}

// Issue -> draft fresh names, create a new branch + worktree, seed with the issue.
function runIssueFlow(ref, agent, config, cwd) {
  output.write(`\nReading issue #${ref.number}...\n`);
  const issue = fetchIssue(ref, cwd);

  output.write("Drafting branch/workspace names...\n");
  const names = draftNames(issue, config);
  output.write(`  branch    : ${names.branch}\n`);
  output.write(`  workspace : ${names.workspace}\n`);

  const base = detectBaseRef(cwd, config);
  output.write(`\nCreating worktree${base ? ` off ${base}` : ""}...\n`);
  const createArgs = [
    "worktree",
    "create",
    "--cwd",
    cwd,
    "--branch",
    names.branch,
    "--label",
    names.workspace,
    "--focus",
    "--json",
  ];
  if (base) createArgs.push("--base", base);

  launchAgent({
    response: runHerdrJson(createArgs),
    branch: names.branch,
    agent,
    config,
    seedTemplate: config.promptTemplate,
    seedValues: {
      url: issue.url || ref.url,
      title: issue.title,
      number: issue.number,
      branch: names.branch,
      workspace: names.workspace,
    },
  });
}

// PR -> import the existing (remote) head branch into a worktree, seed for review/dev.
function runPrFlow(ref, agent, config, cwd) {
  output.write(`\nReading pull request #${ref.number}...\n`);
  const pr = fetchPr(ref, cwd);

  output.write(`Importing PR head branch ${pr.headRefName || `pr-${pr.number}`}...\n`);
  const branch = importPrBranch(pr, cwd);
  const label = compactLabel(pr.title, branch);

  output.write(`\nOpening worktree on ${branch}...\n`);
  launchAgent({
    response: openWorktree(branch, label, cwd),
    branch,
    agent,
    config,
    seedTemplate: config.prPromptTemplate,
    seedValues: { url: pr.url || ref.url, title: pr.title, number: pr.number, branch, workspace: label },
  });
}

// Raw branch name -> import the remote branch into a worktree.
function runBranchFlow(ref, agent, config, cwd) {
  output.write(`\nImporting remote branch ${ref.branch}...\n`);
  const branch = importRemoteBranch(ref.branch, cwd);
  const label = compactLabel(branch, branch);

  output.write(`\nOpening worktree on ${branch}...\n`);
  launchAgent({
    response: openWorktree(branch, label, cwd),
    branch,
    agent,
    config,
    seedTemplate: config.branchPromptTemplate,
    seedValues: { branch, workspace: label },
  });
}

async function main() {
  const config = loadConfig();
  output.write("\x1b[2J\x1b[H");
  output.write("GitHub Issue / PR -> Worktree\n\n");

  const cwd = context.workspace_cwd || context.focused_pane_cwd || process.env.PWD || process.cwd();
  const rl = readline.createInterface({ input, output });
  const agents = Object.keys(config.agents);
  const defaultAgent = normalizeAgent(config.defaultAgent, config) || agents[0];

  const rawItem = await rl.question("GitHub issue/PR URL or number, or branch name: ");
  const ref = parseRef(rawItem);
  if (!ref) {
    output.write("\nNot a recognizable issue/PR/branch reference. Cancelled.\n");
    rl.close();
    return;
  }

  let agent = "";
  while (!agent) {
    const answer = await rl.question(`Agent [${agents.join("/")}] (${defaultAgent}): `);
    agent = !answer.trim() ? defaultAgent : normalizeAgent(answer, config);
    if (!agent) output.write(`Type one of: ${agents.join(", ")}.\n`);
  }
  rl.close();

  const kind = ref.kind === "unknown" ? resolveKind(ref, cwd) : ref.kind;
  if (kind === "pr") return runPrFlow(ref, agent, config, cwd);
  if (kind === "branch") return runBranchFlow(ref, agent, config, cwd);
  return runIssueFlow(ref, agent, config, cwd);
}

main().catch((error) => {
  output.write(`\nError: ${error.message}\n`);
  process.exitCode = 1;
});

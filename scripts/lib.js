"use strict";

// Shared helpers for the worktree-remove plugin (used by remove.js + confirm.js).

const { spawnSync } = require("node:child_process");

const herdr = process.env.HERDR_BIN_PATH || "herdr";

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function runHerdrJson(args) {
  const r = run(herdr, args);
  if (r.error) throw new Error(`${herdr} ${args.join(" ")} failed to start: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`${herdr} ${args.join(" ")} failed: ${(r.stderr || r.stdout || `exit ${r.status}`).trim()}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`${herdr} ${args.join(" ")} returned non-JSON: ${r.stdout.trim()}`);
  }
}

// Best-effort toast; never throws (feedback must not break the flow).
function notify(title, body) {
  const args = ["notification", "show", title];
  if (body) args.push("--body", body);
  try {
    run(herdr, args);
  } catch {
    /* ignore */
  }
}

function readJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// Resolve the raw `workspace list` entry for the focused (or explicitly
// targeted) workspace, whether or not it's a worktree. Returns null if
// there's no focused workspace.
function resolveFocused({ preferId, preferCwd } = {}) {
  const data = runHerdrJson(["workspace", "list"]);
  const list = data?.result?.workspaces || [];
  return (
    (preferId && list.find((w) => w.workspace_id === preferId)) ||
    (preferCwd && list.find((w) => w.worktree?.checkout_path === preferCwd)) ||
    list.find((w) => w.focused) ||
    null
  );
}

// Resolve the worktree to act on. Prefer an explicit id/cwd (passed from the
// triggering context, authoritative even if focus shifts to an overlay);
// otherwise fall back to the focused workspace. Returns
// { workspaceId, path, branch, label } or { error }.
function resolveWorktree({ preferId, preferCwd } = {}) {
  const target = resolveFocused({ preferId, preferCwd });
  if (!target) return { error: "No focused workspace to remove." };

  const wt = target.worktree;
  const label = target.label || target.workspace_id;
  if (!wt) return { error: `"${label}" is not a worktree.` };
  if (!wt.is_linked_worktree) return { error: `"${label}" is the main checkout — refusing to remove it.` };

  return {
    workspaceId: target.workspace_id,
    path: wt.checkout_path,
    // `workspace list` doesn't carry the branch, so ask git directly.
    branch: currentBranch(wt.checkout_path) || wt.branch || "",
    label,
  };
}

function currentBranch(cwd) {
  const r = run("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  const name = r.status === 0 ? r.stdout.trim() : "";
  return name === "HEAD" ? "" : name; // detached
}

// Lines from `git status --porcelain` (modified, staged, AND untracked) — any
// output means git/herdr would require --force to remove the worktree.
function dirtyFiles(cwd) {
  const r = run("git", ["-C", cwd, "status", "--porcelain"]);
  if (r.status !== 0) return [];
  return r.stdout.split("\n").map((l) => l.replace(/\s+$/, "")).filter(Boolean);
}

function removeWorktree(workspaceId, force) {
  const args = ["worktree", "remove", "--workspace", workspaceId, "--json"];
  if (force) args.push("--force");
  return runHerdrJson(args);
}

// Close a plain (non-worktree) workspace — same effect as the built-in
// close_workspace action, which this plugin's key now stands in for.
function closeWorkspace(workspaceId) {
  return runHerdrJson(["workspace", "close", workspaceId]);
}

module.exports = {
  herdr,
  run,
  runHerdrJson,
  notify,
  readJson,
  resolveFocused,
  resolveWorktree,
  dirtyFiles,
  removeWorktree,
  closeWorkspace,
};

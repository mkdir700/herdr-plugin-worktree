#!/usr/bin/env node
"use strict";

// Action entrypoint (bound to prefix+shift+d, replacing the built-in
// close_workspace — see config.toml). Resolves the focused workspace:
//   - no focused workspace      -> notify and stop
//   - not a (linked) worktree   -> fall back to closing the workspace, same
//                                  as the built-in close_workspace this key
//                                  used to be bound to
//   - clean worktree            -> remove immediately (headless) + notify
//   - dirty worktree            -> open the confirmation overlay (confirm.js),
//                                  which force-removes only after you confirm
//
// Runs headless, so the clean/close paths never flash an overlay.

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const lib = require(path.join(__dirname, "lib.js"));

try {
  const target = lib.resolveFocused();
  if (!target) {
    lib.notify("Remove worktree", "No focused workspace to remove.");
    process.exit(0);
  }

  if (!target.worktree || !target.worktree.is_linked_worktree) {
    lib.closeWorkspace(target.workspace_id);
    process.exit(0);
  }

  const wt = lib.resolveWorktree({ preferId: target.workspace_id });
  if (wt.error) {
    lib.notify("Remove worktree", wt.error);
    process.exit(0);
  }

  if (lib.dirtyFiles(wt.path).length === 0) {
    lib.runSupersetTeardown(wt.path);
    lib.removeWorktree(wt.workspaceId, false);
    lib.notify("Worktree removed", `${wt.branch || wt.label} (clean)`);
    process.exit(0);
  }

  // Dirty: hand off to the overlay so the user can confirm discarding the work.
  const result = spawnSync(
    lib.herdr,
    [
      "plugin",
      "pane",
      "open",
      "--plugin",
      "worktree",
      "--entrypoint",
      "confirm",
      "--placement",
      "overlay",
      "--focus",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? (result.error ? 1 : 0));
} catch (error) {
  lib.notify("Remove worktree failed", error.message);
  process.exit(1);
}

#!/usr/bin/env node
"use strict";

// Confirmation overlay for removing a DIRTY worktree. Lists the uncommitted /
// untracked changes, then force-removes only if you type "y" (this discards the
// changes permanently). Opened by remove.js; targets the worktree from the
// triggering context (authoritative even though the overlay now holds focus).

const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");
const lib = require(path.join(__dirname, "lib.js"));

const context = lib.readJson(process.env.HERDR_PLUGIN_CONTEXT_JSON) || {};

async function main() {
  output.write("\x1b[2J\x1b[H");
  output.write("Remove worktree\n\n");

  const wt = lib.resolveWorktree({
    preferId: context.workspace_id,
    preferCwd: context.workspace_cwd || context.focused_pane_cwd,
  });
  if (wt.error) {
    output.write(`${wt.error}\nNothing removed.\n`);
    return;
  }

  const dirty = lib.dirtyFiles(wt.path);
  if (dirty.length === 0) {
    // Became clean between the action and now — just remove it.
    lib.removeWorktree(wt.workspaceId, false);
    output.write(`Removed ${wt.branch || wt.label} (clean).\n`);
    return;
  }

  output.write(`Branch : ${wt.branch || "(detached)"}\n`);
  output.write(`Path   : ${wt.path}\n\n`);
  output.write(`This worktree has ${dirty.length} uncommitted/untracked change(s):\n`);
  for (const f of dirty.slice(0, 20)) output.write(`  ${f}\n`);
  if (dirty.length > 20) output.write(`  ... and ${dirty.length - 20} more\n`);
  output.write("\nForce-remove and PERMANENTLY DISCARD these changes?\n");

  const rl = readline.createInterface({ input, output });
  const answer = (await rl.question("Type 'y' to confirm, anything else to cancel: ")).trim().toLowerCase();
  rl.close();

  if (answer !== "y" && answer !== "yes") {
    output.write("\nCancelled. Worktree kept.\n");
    return;
  }

  lib.removeWorktree(wt.workspaceId, true);
  output.write(`\nRemoved ${wt.branch || wt.label} (forced — changes discarded).\n`);
}

main().catch((error) => {
  output.write(`\nError: ${error.message}\n`);
  process.exitCode = 1;
});

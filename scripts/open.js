#!/usr/bin/env node
"use strict";

// Action entrypoint: open the plugin's prompt pane as a focused overlay.
// All the real work happens in scripts/prompt.js (the overlay's command).

const { spawnSync } = require("node:child_process");

const herdr = process.env.HERDR_BIN_PATH || "herdr";
const result = spawnSync(
  herdr,
  [
    "plugin",
    "pane",
    "open",
    "--plugin",
    "github-issue-worktree",
    "--entrypoint",
    "prompt",
    "--placement",
    "overlay",
    "--focus",
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? (result.error ? 1 : 0));

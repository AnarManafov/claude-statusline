# claude-statusline

A status line for [Claude Code](https://code.claude.com), kept in one place and
installed onto every machine from this repo.

```
◆ Opus 5 │ user@host:~/proj ⎇ main │ ctx ██░░░░░░░░ 21% │ 5h 40% (2h10m) pace 80% │ week 12% (4d3h) pace 60%
```

| Segment | Meaning |
|---|---|
| `ctx` | context window used |
| `5h` | the five-hour quota window: used %, time until reset, pace |
| `week` | the 7-day quota window: same |

`pace` is used% ÷ elapsed% of the window. 100% is an even burn that lands exactly
on the reset; below that there is headroom, above it the window runs out early.
It stays hidden for the first half hour of a window, because one prompt at minute
two prints a wild number.

## Install

Requires [Node](https://nodejs.org) — already a hard requirement for the status
line itself, so the installer is Node rather than a shell-script pair.

```sh
git clone git@github.com:AnarManafov/claude-statusline.git
cd claude-statusline
node install.mjs
```

Then restart Claude Code.

To update a machine later:

```sh
git pull && node install.mjs
```

The installer copies `statusline.js` into `~/.claude/` and patches **only** the
`statusLine` key of `~/.claude/settings.json`. Everything else in that file —
`theme`, `enabledPlugins`, `attribution`, `editorMode` — is read back and
rewritten untouched, because those legitimately differ per machine. It honours
`CLAUDE_CONFIG_DIR` if set.

## Why the command string is written per-OS

Per the [status line docs](https://code.claude.com/docs/en/statusline#windows-configuration),
Claude Code on Windows routes the command through **Git Bash if Git Bash is
installed, and through PowerShell if it is not**. PowerShell does not expand `~`
for native-command arguments, so `node ~/.claude/statusline.js` — correct on
macOS — fails silently there. And Git Bash strips unquoted backslashes as
escapes, which fails with no visible error.

So the installer writes an absolute, forward-slashed, quoted path on Windows and
the `~` form on macOS. Forward slashes are safe under both Windows shells.

Installing Git for Windows flips the routing from PowerShell to Git Bash, which
is exactly the kind of unrelated change that can blank the line on a machine that
was working yesterday. The forward-slash form survives both.

## What this repo does not carry

| File | Why not |
|---|---|
| `statusline-windows.json` | per-machine learned state. Syncing it feeds one machine's observations to another and corrupts the pace maths. |
| `settings.json` | no secrets today, but it is the file that grows `env`, `apiKeyHelper` and MCP tokens over time. |
| `.credentials.json` | live OAuth tokens. It lives in `~/.claude/` beside `statusline.js`. |

The layout is the safeguard, not the `.gitignore`: the repo lives outside
`~/.claude` and the installer copies *into* it. **Never run `git init` inside
`~/.claude`** — that is the one realistic path by which `.credentials.json`
reaches a remote.

`statusline.js` itself is machine-agnostic by construction: `os.homedir()`,
`os.hostname()`, `os.userInfo()`, no hardcoded paths, and no network calls.

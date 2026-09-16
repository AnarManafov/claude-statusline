#!/usr/bin/env node
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
mkdirSync(dir, { recursive: true });

const target = join(dir, 'statusline.js');
copyFileSync(new URL('statusline.js', import.meta.url), target);

// Forward slashes on Windows: Git Bash eats backslashes.
const command = platform() === 'win32'
  ? `node "${target.replace(/\\/g, '/')}"`
  : 'node ~/.claude/statusline.js';

const file = join(dir, 'settings.json');
let settings = {};
try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch {}
settings.statusLine = { type: 'command', command };   // patch ONLY this key
writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');

console.log(`installed → ${target}\n  command: ${command}`);

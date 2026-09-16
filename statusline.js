#!/usr/bin/env node
// Claude Code status line.
//
//   ◆ Opus 5 │ user@host:~/proj ⎇ main │ ctx ██░░░░░░░░ 21% │ cache 42m 94% │ 5h 40% (2h10m) pace 80% │ week 12% (4d3h) pace 60%
//
//   ctx    context window used
//   cache  prompt cache: time until the cached prefix expires, session hit
//          ratio. "cache cold 95k" once expired: tokens the next prompt re-bills.
//   5h     the five-hour quota window: used %, time until reset, pace
//   week   the 7-day quota window: same
//
// pace = used% ÷ elapsed% of the window. 100% is an even burn that lands
// exactly on the reset; below that you have headroom, above it you run out
// before the reset if you keep going. It is hidden for the first
// PACE_MIN_ELAPSED_S of a window, because one prompt at minute two would
// otherwise print a wild number. Early in a week the ratio is still coarse:
// a single prompt is a large share of the time elapsed so far.
//
// The "5h" window is only nominally five hours: resets are hour-snapped, so a
// window runs up to 6 h and a countdown of "5h28m" next to "5h" is normal. The
// five_hour reset header also runs an hour late; see RESET_SKEW.
//
// All live data comes from the status-line stdin JSON; the only external call
// is one cheap `git` for the branch. No network. Node rather than bash so the
// same command works on macOS, WSL and Windows-native.

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// --- settings ----------------------------------------------------------------
const PACE_MIN_ELAPSED_S = 30 * 60;  // show pace once this much of a window has passed
const PACE_WARN = 100;           // pace above this is yellow
const PACE_ALARM = 130;          // pace above this is red
const NOMINAL = { five_hour: 5 * 3600, seven_day: 7 * 86400 };
// Correction added to each window's resets_at, in seconds. The five_hour
// reset header runs one hour late: two windows were measured at 6.55 h and
// 6.59 h from the header, and a 5 h window snapped up to the next hour can
// never exceed 6 h. Taking an hour off gives 5.55 h and 5.59 h, which fits.
// The seven_day header matches the /usage cadence exactly, so no correction.
// Set to 0 if `/usage` ever shows the same reset time as the raw header.
const RESET_SKEW = { five_hour: -3600 };
// Prompt cache. The countdown goes yellow when less than CACHE_WARN_FRACTION of
// the TTL is left; the hit ratio is dim at or above CACHE_HIT_WARN, yellow down
// to CACHE_HIT_ALARM, red below. The ratio is cache-read tokens over all input
// tokens this session, so it starts low and climbs; judge it after a few turns.
const CACHE_TTL_S = { '5m': 300, '1h': 3600 };
const CACHE_WARN_FRACTION = 0.15;
const CACHE_HIT_WARN = 80;
const CACHE_HIT_ALARM = 50;
// Learned window lengths. Overridable so tests never touch the real file.
const STATE_FILE = process.env.STATUSLINE_STATE ||
  path.join(os.homedir(), '.claude', 'statusline-windows.json');

// --- colours -----------------------------------------------------------------
const RST = '\x1b[0m', DIM = '\x1b[2m', GRY = '\x1b[90m';
const BGRN = '\x1b[1;32m', BBLU = '\x1b[1;34m', MAG = '\x1b[1;35m';
const GRN = '\x1b[32m', YEL = '\x1b[33m', RED = '\x1b[31m';
const SEP = `${GRY} │ ${RST}`;
const label = (s) => `${GRY}${s}${RST}`;
const dim = (s) => `${DIM}${s}${RST}`;

// --- input -------------------------------------------------------------------
let data = {};
try { data = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { data = {}; }

const dig = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

const NOW = Math.floor(Date.now() / 1000);
const MODEL = dig(data, 'model.display_name') ?? '?';
const CWD = dig(data, 'workspace.current_dir') ?? data.cwd ?? '';
const CTX = dig(data, 'context_window.used_percentage');
const LIMITS = dig(data, 'rate_limits') ?? {};

// --- helpers -----------------------------------------------------------------
const toInt = (v) => {
  if (v == null || v === '') return null;
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
};

// A sane percentage (0-100). Guards against schema drift putting an epoch or
// similar into a percent slot.
const isPct = (v) => { const p = toInt(v); return p != null && p >= 0 && p <= 100; };

// Absolute-level colour: how full is it.
const pctColor = (v) => { const p = toInt(v) ?? 0; return p < 50 ? GRN : p < 80 ? YEL : RED; };

const bar = (v) => {
  const f = Math.min(10, Math.max(0, Math.floor(((toInt(v) ?? 0) + 5) / 10)));
  return '█'.repeat(f) + '░'.repeat(10 - f);
};

// Token counts: "95k", "1.2M".
const kTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

// Time until the reset: "6d20h" / "6h28m" / "45m" / "40s". Two units, because
// flooring to one hides almost a day at "6d". The finer unit is dropped when zero.
const remaining = (epoch) => {
  const t = toInt(epoch);
  if (t == null) return '';
  const s = Math.max(0, t - NOW);
  if (s < 60) return `${s}s`;
  if (s >= 86400) {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    return h ? `${d}d${h}h` : `${d}d`;
  }
  if (s >= 3600) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return m ? `${h}h${m}m` : `${h}h`;
  }
  return `${Math.floor(s / 60)}m`;
};

// --- window length learning --------------------------------------------------
// The API reports only when a window ends, never when it began, and the
// nominal length is unreliable (see header). Within one window `remaining`
// only counts down, so the largest remaining ever seen is that window's true
// length. Kept per reset timestamp; a new resets_at starts a fresh
// observation, with the nominal length as a floor for a window first met
// mid-flight.
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch { state = {}; }
let stateDirty = false;

// How far into the window we are: { seconds, fraction }, or null if unknown.
const windowElapsed = (key, resetsAt) => {
  const end = toInt(resetsAt);
  if (end == null) return null;
  const remaining = Math.max(0, end - NOW);

  const st = state[key];
  if (!st || st.resets_at !== end) {
    state[key] = { resets_at: end, max_remaining: remaining };
    stateDirty = true;
  } else if (remaining > st.max_remaining) {
    st.max_remaining = remaining;
    stateDirty = true;
  }

  const duration = Math.max(NOMINAL[key] ?? 0, state[key].max_remaining);
  if (duration <= 0) return null;
  const seconds = duration - remaining;
  return { seconds, fraction: seconds / duration };
};

// pace as a whole-number percentage, or null while it is too early to say.
const pace = (key, usedPct, resetsAt) => {
  const used = Number(usedPct);
  const w = windowElapsed(key, resetsAt);
  if (!Number.isFinite(used) || w == null) return null;
  if (w.seconds < PACE_MIN_ELAPSED_S || w.fraction > 1) return null;
  return Math.round(used / w.fraction);
};

const paceTag = (p) => {
  if (p == null) return '';
  const c = p <= PACE_WARN ? DIM : p <= PACE_ALARM ? YEL : RED;
  return ` ${label('pace')} ${c}${p}%${RST}`;
};

// One quota segment: "5h 40% (2h10m) pace 80%".
const quota = (name, key) => {
  const w = LIMITS[key];
  if (!w || !isPct(w.used_percentage)) return '';
  let s = `${SEP}${label(name)} ${pctColor(w.used_percentage)}${toInt(w.used_percentage)}%${RST}`;
  const raw = toInt(w.resets_at);
  const resetsAt = raw == null ? null : raw + (RESET_SKEW[key] ?? 0);
  const left = remaining(resetsAt);
  if (left) s += ` ${dim(`(${left})`)}`;
  return s + paceTag(pace(key, w.used_percentage, resetsAt));
};

// --- prompt cache ------------------------------------------------------------
// "cache 42m 94%" while the cached prefix is alive; "cache cold 95k" once it
// has expired, where 95k is what the next prompt re-bills. Absent until the
// session has actually seen caching. Claude Code re-runs the status line at
// the expiry moment, so the flip to "cold" is on time even without a refresh
// interval; the countdown itself only advances when the line is re-rendered.
const cacheSeg = () => {
  const c = data.prompt_cache;
  if (!c || !c.caching_observed) return '';
  let s = `${SEP}${label('cache')}`;
  const exp = toInt(c.expires_at);
  if (c.warm && exp != null && exp > NOW) {
    const ttl = CACHE_TTL_S[c.ttl] ?? CACHE_TTL_S['5m'];
    const col = exp - NOW < ttl * CACHE_WARN_FRACTION ? YEL : DIM;
    s += ` ${col}${remaining(exp)}${RST}`;
  } else {
    const cold = Number(c.recache_tokens_if_cold);
    s += ` ${YEL}cold${cold > 0 ? ` ${kTokens(cold)}` : ''}${RST}`;
  }
  const ratio = Number(c.hit_ratio);
  if (c.hit_ratio != null && Number.isFinite(ratio)) {
    const r = Math.round(ratio * 100);
    const col = r >= CACHE_HIT_WARN ? DIM : r >= CACHE_HIT_ALARM ? YEL : RED;
    s += ` ${col}${r}%${RST}`;
  }
  return s;
};

// --- identity: user@host:~/path ⎇ branch --------------------------------------
const HOME = os.homedir();
const where = HOME && CWD.startsWith(HOME) ? '~' + CWD.slice(HOME.length) : CWD;

const git = (...args) => {
  try {
    return execFileSync('git', ['-C', CWD, ...args],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
  } catch { return ''; }
};
const branch = CWD
  ? git('symbolic-ref', '--quiet', '--short', 'HEAD') || git('rev-parse', '--short', 'HEAD')
  : '';

const host = os.hostname().split('.')[0];
let user = '';
try { user = os.userInfo().username; } catch {}

// --- assemble ----------------------------------------------------------------
let out = `${MAG}◆ ${MODEL}${RST}${SEP}${BGRN}${user}@${host}${RST}:${BBLU}${where}${RST}`;
if (branch) out += ` ${GRY}⎇${RST} ${YEL}${branch}${RST}`;
if (isPct(CTX)) out += `${SEP}${label('ctx')} ${pctColor(CTX)}${bar(CTX)} ${toInt(CTX)}%${RST}`;
out += cacheSeg();
out += quota('5h', 'five_hour');
out += quota('week', 'seven_day');

// Persist only on a real change so the common render does no disk write.
if (stateDirty) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
}

process.stdout.write(out);

/**
 * Docker plugin — container status polling and display.
 *
 * Provides panel type: containers
 * Provides status data used by core groups renderer.
 */
'use strict';

const { spawn } = require('child_process');

// All host capabilities flow through the plugin API surface — see
// PLUGINS.md "Plugin API". Direct imports from `../ansi` etc. would
// still work but are not part of the documented contract.
const {
  esc, visibleLen, theme, renderPanel,
  getSel, getScroll, isMultiSel, getFilter,
  execAsync, decorate,
  streamCommand, addEphemeralTab, scheduleRender,
  getItems: apiGetItems, selectedOrFocused,
  hub,
} = require('./api');

const statusCache = {};
const statsCache = {};   // name -> { cpu: '3.2%', mem: '120MB / 2GB' }
let pluginConfig = {};

// --- Events stream (live state-change subscription) ---
//
// `docker events --filter type=container --format '{{json .}}'` is a
// long-lived stream. We subscribe once and parse JSON-per-line. Events
// for tracked containers trigger a debounced refresh + render so state
// transitions (start, stop, die, restart, kill) reflect in the TUI in
// near-real-time instead of waiting up to 10s for the next poll.
//
// The 10s poll keeps running as a safety net (catches missed events,
// also refreshes stats — `docker events` carries no cpu/mem numbers).

let _eventsProc = null;
let _eventsBuf = '';
let _eventsRefreshTimer = null;
let _eventsExitHandler = null;
const EVENTS_DEBOUNCE_MS = 200;
const EVENTS_RECONNECT_MS = 5000;

/**
 * True when `name` appears in any group's `containers:` list — used to
 * filter docker events for noise (events from containers we don't track).
 */
function isTrackedContainer(name, config) {
  if (!config || !config.groups) return false;
  for (const g of Object.values(config.groups)) {
    if (g && g.containers && g.containers.includes(name)) return true;
  }
  return false;
}

/**
 * Parse one line of `docker events --format '{{json .}}'`, filter to
 * tracked containers, schedule a debounced refresh on hit. Pure-ish:
 * `refreshFn` and `renderFn` are injected so the function is testable
 * without spawning processes. Caller owns `state` (the timer handle
 * lives in module scope; this function reads/writes it).
 *
 * Returns true if the event was tracked (test-friendly), false otherwise.
 */
function handleEventLine(line, config, refreshFn, renderFn) {
  let evt;
  try { evt = JSON.parse(line); }
  catch { return false; }
  // docker events JSON: { Type, Action, Actor: { ID, Attributes: { name, ... } }, ... }
  const name = evt && evt.Actor && evt.Actor.Attributes && evt.Actor.Attributes.name;
  if (!name) return false;
  if (!isTrackedContainer(name, config)) return false;
  if (_eventsRefreshTimer) clearTimeout(_eventsRefreshTimer);
  _eventsRefreshTimer = setTimeout(async () => {
    _eventsRefreshTimer = null;
    try {
      const changed = await refreshFn(config);
      if (changed && renderFn) renderFn();
    } catch (e) {
      console.error(`[docker:events] refresh after event failed: ${e.message}`);
    }
  }, EVENTS_DEBOUNCE_MS);
  return true;
}

/**
 * Idempotent: starts the events stream if not already running. Called
 * from `refresh()` so the stream comes up after the first poll has
 * established state. Auto-reconnects on stream death (docker daemon
 * restart, etc.).
 */
function startEventsStream(config) {
  if (_eventsProc) return;
  let proc;
  try {
    proc = spawn('docker',
      ['events', '--filter', 'type=container', '--format', '{{json .}}'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    console.error(`[docker:events] spawn failed: ${e.message}`);
    return;
  }
  _eventsProc = proc;
  _eventsBuf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    _eventsBuf += chunk;
    let nl;
    while ((nl = _eventsBuf.indexOf('\n')) >= 0) {
      const line = _eventsBuf.slice(0, nl).trim();
      _eventsBuf = _eventsBuf.slice(nl + 1);
      if (line) handleEventLine(line, config, refresh, scheduleRender);
    }
  });
  proc.on('exit', () => {
    if (_eventsProc === proc) _eventsProc = null;
    // Reconnect if config still has containers worth watching. Skip
    // reconnect if the process was killed during cleanup (proc.killed).
    if (!proc.killed) {
      setTimeout(() => startEventsStream(config), EVENTS_RECONNECT_MS);
    }
  });
  proc.on('error', (e) => {
    console.error(`[docker:events] stream error: ${e.message}`);
  });
  if (!_eventsExitHandler) {
    _eventsExitHandler = stopEventsStream;
    process.on('exit', _eventsExitHandler);
  }
}

function stopEventsStream() {
  if (_eventsRefreshTimer) {
    clearTimeout(_eventsRefreshTimer);
    _eventsRefreshTimer = null;
  }
  if (_eventsProc) {
    try { _eventsProc.kill(); } catch { /* already dead */ }
    _eventsProc = null;
  }
}

function init(config) {
  pluginConfig = config || {};
  // Hub topic schema — feeds the stats panel's axis scaling and value
  // formatting. See STATS.md §5 + HUB.md §17.
  hub.defineTopic('docker.stats', {
    rowKey: 'container_name',
    columns: {
      cpu:      { type: 'percent', unit: '%' },
      mem:      { type: 'bytes',   unit: 'B' },
      // Scale reference, not a metric — `meta: true` keeps it out of
      // default-metric inference but keeps it accessible to consumers
      // that want to scale `mem` against the container's memory limit.
      memLimit: { type: 'bytes',   unit: 'B', meta: true },
    },
  });
}

/** Strip docker's leading '/' from container names. */
function unprefix(name) { return name.replace(/^\//, ''); }

// --- Stats string parsers (for hub publish — string forms stay in
// statsCache for getInfo/copyOptions). ---

const _BYTE_UNITS = {
  'B': 1,
  'KB': 1e3, 'KIB': 1024,
  'MB': 1e6, 'MIB': 1024 ** 2,
  'GB': 1e9, 'GIB': 1024 ** 3,
  'TB': 1e12, 'TIB': 1024 ** 4,
};

function parseBytes(s) {
  if (!s) return NaN;
  const m = String(s).trim().match(/^([\d.]+)\s*([kKMmGgTt]?[iI]?[bB])?$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'B').toUpperCase();
  const mul = _BYTE_UNITS[unit];
  return mul ? n * mul : NaN;
}

/** "120MiB / 2GiB" → { used: 125_829_120, limit: 2_147_483_648 } */
function parseMem(s) {
  if (!s) return { used: NaN, limit: NaN };
  const parts = String(s).split('/').map(p => p.trim());
  return { used: parseBytes(parts[0]), limit: parseBytes(parts[1] || '') };
}

function parsePercent(s) {
  if (!s) return NaN;
  const m = String(s).trim().match(/^([\d.]+)\s*%?$/);
  return m ? parseFloat(m[1]) : NaN;
}

/**
 * Refresh container status and resource stats. Async — uses execAsync so
 * docker daemon slowness (e.g. during a build) doesn't block the event loop.
 * Returns Promise<boolean> — true if anything changed.
 */
async function refresh(config) {
  const containers = [];
  for (const g of Object.values(config.groups)) {
    containers.push(...(g.containers || []));
  }
  if (!containers.length) return false;

  // Bring the events stream up after we have config in hand. Idempotent —
  // subsequent refresh calls are no-ops while the stream is alive.
  startEventsStream(config);

  let changed = false;
  const args = containers.map(JSON.stringify).join(' ');

  // Batched status check. Note: docker inspect exits non-zero if ANY container
  // is missing, but still writes valid output for existing ones — execAsync
  // captures stdout regardless of exit code.
  const inspectOut = await execAsync(
    `docker inspect -f "{{.Name}}\t{{.State.Status}}" ${args} 2>/dev/null`,
    { timeout: 5000 },
  );
  const seenStatus = new Set();
  for (const line of inspectOut.split('\n').filter(Boolean)) {
    const [rawName, status] = line.split('\t');
    if (!rawName) continue;
    const name = unprefix(rawName);
    seenStatus.add(name);
    const st = (status || '').trim() || 'unknown';
    if (statusCache[name] !== st) { statusCache[name] = st; changed = true; }
  }
  for (const name of containers) {
    if (!seenStatus.has(name) && statusCache[name] !== 'unknown') {
      statusCache[name] = 'unknown';
      changed = true;
    }
  }

  // Stats for running containers only.
  const running = containers.filter(c => statusCache[c] === 'running');
  if (running.length) {
    const sargs = running.map(JSON.stringify).join(' ');
    const statsOut = await execAsync(
      `docker stats --no-stream --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" ${sargs} 2>/dev/null`,
      { timeout: 5000 },
    );
    const seen = new Set();
    const ts = Date.now();
    for (const line of statsOut.split('\n').filter(Boolean)) {
      const [name, cpu, mem] = line.split('\t');
      if (!name) continue;
      seen.add(name);
      const next = { cpu: (cpu || '').trim(), mem: (mem || '').trim() };
      const prev = statsCache[name];
      if (!prev || prev.cpu !== next.cpu || prev.mem !== next.mem) {
        statsCache[name] = next;
        changed = true;
      }
      // Publish a numeric sample on every tick so the time series
      // advances even when the formatted strings happen to repeat.
      // hub.publish drops cheaply when nobody is subscribed.
      const memInfo = parseMem(next.mem);
      hub.publish('docker.stats', name, {
        ts,
        cpu: parsePercent(next.cpu),
        mem: memInfo.used,
        memLimit: memInfo.limit,
      });
    }
    for (const name of containers) {
      if (!seen.has(name) && statsCache[name]) {
        delete statsCache[name];
        hub.delete('docker.stats', name);
        changed = true;
      }
    }
  } else {
    for (const name of Object.keys(statsCache)) {
      delete statsCache[name];
      hub.delete('docker.stats', name);
      changed = true;
    }
  }

  return changed;
}

function cachedStatus(name) { return statusCache[name] || '?'; }
function cachedStats(name) { return statsCache[name] || null; }

/**
 * Auto-generate docker compose actions for groups that have a `compose:`
 * field. Lets users skip the boilerplate ps/up/down/logs/build/restart
 * action entries in YAML — those become defaults that user actions
 * override (since YAML actions are merged AFTER plugin actions).
 */
function groupActions(group) {
  if (!group || !group.compose) return {};
  // Use -f flag only if compose path isn't the default (docker-compose.yml or compose.yml)
  const f = group.compose;
  const flag = (f === 'docker-compose.yml' || f === 'compose.yml') ? '' : ` -f ${f}`;
  const c = `docker compose${flag}`;
  // Use `script:` (not cmd:) so format matches parser-resolved YAML actions
  // — runAction reads action.script.
  return {
    status: { script: `${c} ps`, type: 'run', label: 'Status', desc: 'Show container status', tab: true },
    up: { script: `${c} up -d --build`, type: 'run', label: 'Start', desc: 'Build and start all services' },
    down: { script: `${c} down`, type: 'run', label: 'Stop', desc: 'Stop and remove all containers',
            confirm: 'Stop all containers in this group?' },
    logs: { script: `${c} logs -f --tail=50`, type: 'spawn', label: 'Logs',
            desc: 'Tail logs from all containers (opens new window)' },
    build: { script: `${c} build`, type: 'run', label: 'Build', desc: 'Build images without starting' },
    restart: { script: `${c} restart`, type: 'run', label: 'Restart', desc: 'Restart all containers',
               confirm: 'Restart all containers?' },
  };
}

// --- Panel type: containers ---

function render(panel, width, height, S) {
  const group = S.config.groups[S.currentGroup];
  if (!group) return '';
  const containers = apiGetItems('containers', S);
  const innerW = width - 2;
  const sel = getSel('containers');
  const isFocused = S.focus === 'containers';
  const t = theme();
  const lines = containers.map((name, i) => {
    const isSel = i === sel && isFocused;
    const ctx = { panelType: 'containers', item: name, selected: isSel, S };
    const left  = decorate('row:left:containers',  { ...ctx, width: 4 });
    const nameLen = visibleLen(esc(name));
    const used = 1 + (left ? visibleLen(left) + 1 : 0) + nameLen;
    const right = decorate('row:right:containers', { ...ctx, width: Math.max(0, innerW - used - 1) });
    const lhead = left  ? `${left} `  : '';
    const rtail = right ? ` ${right}` : '';
    const gutter = isMultiSel('containers', name) ? '*' : ' ';
    if (isSel) return `[${t.selected}]${gutter}${lhead}${esc(name)}${rtail}`;
    return `${gutter}${lhead}${esc(name)}${rtail}`;
  });
  const filterText = getFilter('containers');
  const title = filterText ? `${panel.title} /${esc(filterText)}` : panel.title;
  return renderPanel({
    width, height, lines,
    title, hotkey: panel.hotkey,
    panelType: 'containers',
    focused: isFocused,
    count: containers.length ? [sel + 1, containers.length] : null,
    scrollOffset: getScroll('containers'),
  });
}

/** Raw container names; filtering applied centrally by api.getItems. */
function getItems(S) {
  const group = S.config.groups[S.currentGroup];
  return group ? (group.containers || []) : [];
}

function getInfo(item) {
  const st = cachedStatus(item);
  const lines = [`[bold]${esc(item)}[/]`, '', `[dim]status:[/] ${st}`];
  const stats = cachedStats(item);
  if (stats) {
    lines.push(`[dim]cpu:[/] ${esc(stats.cpu)}`);
    lines.push(`[dim]mem:[/] ${esc(stats.mem)}`);
  }
  return lines;
}

function copyOptions(item) {
  if (!item) return [];
  const status = cachedStatus(item);
  const stats = cachedStats(item);
  const opts = [
    { label: `Container name: ${item}`, content: item },
    { label: `Status: ${status}`, content: status },
  ];
  if (stats) {
    opts.push({ label: `CPU: ${stats.cpu}`, content: stats.cpu });
    opts.push({ label: `Memory: ${stats.mem}`, content: stats.mem });
  }
  // Lazy + async — only fetched when user picks this option, and
  // doesn't block the event loop while docker daemon responds.
  const q = JSON.stringify(item);
  opts.push({
    label: 'Inspect (full JSON)',
    content: () => execAsync(`docker inspect ${q}`, { timeout: 5000 }),
  });
  opts.push({
    label: 'Recent logs (last 200)',
    content: () => execAsync(`docker logs --tail=200 ${q} 2>&1`, { timeout: 5000 }),
  });
  return opts;
}

/**
 * Per-container shortcut keys.
 * `i` → docker inspect (one-shot, jq if available)
 * `t` → docker logs --tail=200 -f (live tail; killed on tab/action switch)
 * `s` → docker exec -it bash|sh — opens as ephemeral terminal tab
 */
function onKey(key, item, S) {
  if (!item) return false;
  const q = JSON.stringify(item);
  if (key === 'i') {
    S.activeTab = 0;
    S.terminalMode = false;
    streamCommand(`inspect ${item}`,
      `docker inspect ${q} 2>&1 | (command -v jq >/dev/null && jq . || cat)`);
    return true;
  }
  if (key === 't') {
    S.activeTab = 0;
    S.terminalMode = false;
    streamCommand(`logs ${item}`,
      `docker logs --tail=200 -f ${q} 2>&1`);
    return true;
  }
  if (key === 's') {
    // bash if present, else sh. The previous `exec bash 2>/dev/null || exec sh`
    // accidentally muted bash's interactive prompt — readline writes the
    // prompt to stderr, and `exec` keeps the redirect alive.
    addEphemeralTab(
      S.currentGroup,
      `shell-${item}`,
      `docker exec -it ${q} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`,
      `sh:${item}`,
    );
    return true;
  }
  return false;
}

// --- Bulk container commands (`:` cmdline mode) ---
//
// Each command reads `selectedOrFocused('containers', S)` so the same
// invocation works on the multi-selected set OR the single focused row.
// No special "bulk" path; the operand resolver makes the distinction
// invisible to the command. See CMDMODE.md + DECORATORS.md retrospective.

function bulkContainer(verb, opts = {}) {
  const desc = opts.desc ||
    `${verb[0].toUpperCase() + verb.slice(1)} selected (or focused) container(s)`;
  const cmdSuffix = opts.cmdSuffix || '';
  return {
    name: verb,
    desc,
    run: (_args, S) => {
      const names = selectedOrFocused('containers', S);
      if (!names.length) return;
      const quoted = names.map(n => JSON.stringify(n)).join(' ');
      // Switch to Info tab so streaming output is visible; clear any
      // running stream first (streamCommand handles that).
      S.activeTab = 0;
      S.terminalMode = false;
      const label = names.length === 1
        ? `${verb} ${names[0]}`
        : `${verb} ${names.length} containers`;
      streamCommand(label, `docker ${verb} ${quoted}${cmdSuffix}`);
    },
  };
}

const containerCommands = [
  bulkContainer('stop'),
  bulkContainer('start'),
  bulkContainer('restart'),
  // Read-only — safe to test without consequences.
  bulkContainer('inspect', {
    desc: 'Inspect selected (or focused) container(s) — read-only',
    cmdSuffix: ' 2>&1 | (command -v jq >/dev/null && jq . || cat)',
  }),
];

// Container row's left-side status glyph, supplied via the decorator
// framework (DECORATORS.md). Plain text on selected rows; colored markup
// otherwise (PRINCIPLES §8 — no [/] inside [reverse]).
function rowLeftContainers(ctx) {
  const name = ctx.item;
  const st = cachedStatus(name);
  const dot = st === 'running' || st === 'stopped' || st === 'exited' ? '●' : '○';
  if (ctx.selected) return dot;
  const t = theme();
  const color = st === 'running' ? t.running
              : (st === 'stopped' || st === 'exited') ? t.stopped
              : t.unknown;
  return `[${color}]${dot}[/]`;
}

module.exports = {
  name: 'docker',
  init,
  refresh,
  // Framework teardown hook (called by cleanupPlugins on quit) — stop
  // the long-lived `docker events` child + its reconnect timer. The
  // process.on('exit') registration stays as a backstop for hard exits.
  cleanup: stopEventsStream,
  // statusFor: generic plugin contract — registry asks all plugins, first
  // non-null wins. Lets core renderers show running/stopped without knowing
  // docker exists. Returns null for names this plugin doesn't track.
  statusFor: (name) => (name in statusCache ? statusCache[name] : null),
  groupActions,
  commands: containerCommands,
  decorators: {
    'row:left:containers': rowLeftContainers,
  },
  panelTypes: {
    containers: {
      mode: 'list',
      render,
      getItems,
      getInfo,
      onKey,
      copyOptions,
      keyHints: 'i inspect | t logs | s shell',
      filterable: true,
      filterText: name => name,
      idOf: name => name,    // container names are already strings; identity is just self
    },
  },
  defaults: { refresh_interval: 10 },
  // Test-only internals (events stream pure helpers + stat parsers).
  _handleEventLine: handleEventLine,
  _isTrackedContainer: isTrackedContainer,
  _stopEventsStream: stopEventsStream,
  _parseBytes: parseBytes,
  _parseMem: parseMem,
  _parsePercent: parsePercent,
};

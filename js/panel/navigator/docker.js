/**
 * Docker — container status/stats polling + display (Component / TEA API).
 *
 * Provides panel type `containers`, the per-container status the core groups
 * renderer reads (statusFor), the row status glyph (decorator), bulk `:` verbs,
 * and auto-generated compose group actions.
 *
 * Component (TEA) model — the polled state lives in the SLICE, not module-
 * global caches:
 *
 *   { status: {name:status}, stats: {name:{cpu,mem}}, inFlight, started, eventsStarted }
 *
 * Periodic refresh is self-driven (there is no framework poll loop for
 * Components — that's the non-TEA artifact v0.5 is removing). The recurrence
 * is a re-armed `tick` effect — the TEA self-re-arming-tick Cmd pattern:
 *
 *   refresh Msg (boot / r / :refresh)  → arm the tick once + poll now.
 *   dockerTick Msg (the re-armed tick) → re-arm + poll (unless blurred or a
 *                                        fetch is already in flight).
 *   dockerPoll Msg (from the events stream, debounced) → one-shot poll.
 *   dockerFetch effect → runs `docker inspect`/`docker stats` OFF-tick,
 *                        publishes the hub stats series, and folds the result
 *                        back via a dockerResult Msg (inFlight guards overlap).
 *
 * The long-lived `docker events --filter type=container` stream is a
 * subscription: a `dockerEventsStart` effect spawns it and, on a debounced
 * tracked-container event, injects a `dockerPoll` Msg (the TEA "external event
 * → Program.Send(msg)" pattern). i/t/s per-row keys arrive as key Msgs and
 * emit stream/shell effects.
 */
'use strict';

const { spawn } = require('child_process');

const {
  esc, theme, renderPanel,
  getSel, getScroll, isMultiSel, getFilter,
  execAsync,
  streamCommand, addEphemeralTab, scheduleRender,
  setActiveTab, leaveTerminalMode,
  getItems: apiGetItems, selectedOrFocused,
  getComponentSlice, getFocus, dispatchMsg, wrap,
  registerEffect,
  hub,
} = require('../api');
const { getModel } = require('../../app/runtime');
const mnav = require('../../leaves/nav');

const POLL_MS = 10000;

// --- slice access (the polled state lives in the Component slice) ---

function _slice()        { return getComponentSlice('docker') || { status: {}, stats: {} }; }
function _status(name)   { return _slice().status[name] || '?'; }
function _stats(name)    { return _slice().stats[name] || null; }

// --- app-global reads (explicit, per the Component contract) ---

function _containers() {
  const cfg = getModel().config || {};
  const out = [];
  for (const g of Object.values(cfg.groups || {})) out.push(...(g.containers || []));
  return out;
}

// --- Events stream (live state-change subscription) ---
//
// `docker events --filter type=container --format '{{json .}}'` is a long-lived
// stream. Subscribe once, parse JSON-per-line; events for tracked containers
// inject a debounced `dockerPoll` Msg so transitions (start/stop/die/restart)
// reflect in near-real-time instead of waiting up to 10s for the next tick.
// The tick keeps running as a safety net (catches missed events + refreshes
// stats — `docker events` carries no cpu/mem numbers).

let _eventsProc = null;
let _eventsBuf = '';
let _eventsRefreshTimer = null;
let _eventsReconnectTimer = null;       // T17: tracked so stopEventsStream can cancel
let _eventsExitHandler = null;
const EVENTS_DEBOUNCE_MS = 200;
const EVENTS_RECONNECT_MS = 5000;

/** True when `name` appears in any group's `containers:` list. */
function isTrackedContainer(name, config) {
  if (!config || !config.groups) return false;
  for (const g of Object.values(config.groups)) {
    if (g && g.containers && g.containers.includes(name)) return true;
  }
  return false;
}

/**
 * Parse one `docker events` line, filter to tracked containers, schedule a
 * debounced refresh on hit. `refreshFn`/`renderFn` are injected so the
 * function is testable without spawning processes (production passes a
 * poll-dispatch fn). Returns true if the event was tracked.
 */
function handleEventLine(line, config, refreshFn, renderFn) {
  let evt;
  try { evt = JSON.parse(line); }
  catch { return false; }
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

// Production event → Msg bridge: a tracked event injects a one-shot poll Msg.
// (Returns true so handleEventLine's renderFn fires — the real data update
// rides back on dockerResult's render effect.)
function _eventPoll() { dispatchMsg(wrap('docker', { type: 'dockerPoll' })); return true; }

/**
 * Idempotent: start the events stream if not already running. Auto-reconnects
 * on stream death (docker daemon restart, etc.).
 */
function startEventsStream(config) {
  if (_eventsProc) return;
  let proc;
  try {
    proc = spawn('docker',
      ['events', '--filter', 'type=container', '--format', '{{json .}}'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    // T17 — pre-fix, a spawn failure (no `docker` on PATH) left the
    // slice's `eventsStarted: true` latch on with no reconnect path
    // ever firing (proc.on('exit') needs a proc). Schedule a retry
    // through the same reconnect timer so a later `docker` install
    // (or PATH fix) eventually picks the stream up.
    console.error(`[docker:events] spawn failed: ${e.message}`);
    if (!_eventsReconnectTimer) {
      _eventsReconnectTimer = setTimeout(() => {
        _eventsReconnectTimer = null;
        startEventsStream(config);
      }, EVENTS_RECONNECT_MS);
      _eventsReconnectTimer.unref();
    }
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
      if (line) handleEventLine(line, config, _eventPoll, scheduleRender);
    }
  });
  proc.on('exit', () => {
    if (_eventsProc === proc) _eventsProc = null;
    if (!proc.killed) {
      // T17 — track the reconnect timer and .unref() it so we don't
      // keep the process alive during the 5s reconnect window. Without
      // the handle, stopEventsStream couldn't cancel it; without
      // .unref(), Node would hang for 5s after the user's quit just
      // to fire a reconnect that immediately gets killed.
      _eventsReconnectTimer = setTimeout(() => {
        _eventsReconnectTimer = null;
        startEventsStream(config);
      }, EVENTS_RECONNECT_MS);
      _eventsReconnectTimer.unref();
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
  if (_eventsRefreshTimer) { clearTimeout(_eventsRefreshTimer); _eventsRefreshTimer = null; }
  // T17 — cancel the pending reconnect too so cleanup() doesn't race
  // with a fresh `docker events` spawn after the TUI quit. Symmetric
  // with the debounce-timer cleanup above.
  if (_eventsReconnectTimer) { clearTimeout(_eventsReconnectTimer); _eventsReconnectTimer = null; }
  if (_eventsProc) {
    try { _eventsProc.kill(); } catch { /* already dead */ }
    _eventsProc = null;
  }
}

// --- Stats string parsers (numeric forms for the hub series) ---

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

/** Strip docker's leading '/' from container names. */
function unprefix(name) { return name.replace(/^\//, ''); }

// --- update + effects (the TEA half) ---

function init() {
  // Hub topic schema — feeds the stats panel's axis scaling + value formatting
  // (STATS.md §5 + HUB.md §17). Defined once at registration, before any publish.
  hub.defineTopic('docker.stats', {
    rowKey: 'container_name',
    columns: {
      cpu:      { type: 'percent', unit: '%' },
      mem:      { type: 'bytes',   unit: 'B' },
      memLimit: { type: 'bytes',   unit: 'B', meta: true },
    },
  });
  return {
    status: {}, stats: {}, inFlight: false, started: false, eventsStarted: false,
    // Phase 4a — nav chrome for the `containers` panel type lives here.
    nav: { containers: mnav.init() },
  };
}

/** Emit a fetch (+ start the events stream the first time) unless one is
 *  already in flight or there are no containers to watch. Pure: returns
 *  [nextSlice, effects]. */
function _maybeFetch(slice) {
  if (slice.inFlight || _containers().length === 0) return [slice, []];
  const effects = [];
  const next = { ...slice, inFlight: true };
  if (!slice.eventsStarted) { next.eventsStarted = true; effects.push({ type: 'dockerEventsStart' }); }
  effects.push({ type: 'dockerFetch' });
  return [next, effects];
}

function update(msg, slice) {
  // Phase 4a — nav chrome Msgs handled by the shared leaf.
  if (mnav.isNavMsg(msg)) return mnav.apply(slice, msg);
  if (msg.type === 'refresh') {
    // boot + r + :refresh. Arm the recurring tick once; poll immediately.
    let next = slice;
    const armed = [];
    if (!slice.started) {
      next = { ...next, started: true };
      armed.push({ type: 'tick', ms: POLL_MS, msg: wrap('docker', { type: 'dockerTick' }) });
    }
    const [n2, fx] = _maybeFetch(next);
    return [n2, armed.concat(fx)];
  }
  if (msg.type === 'dockerTick') {
    // Re-arm regardless (so cadence resumes after a blur), then poll if able.
    const armed = [{ type: 'tick', ms: POLL_MS, msg: wrap('docker', { type: 'dockerTick' }) }];
    if (require('../../app/runtime').getModel().focused === false) return [slice, armed];
    const [next, fx] = _maybeFetch(slice);
    return [next, armed.concat(fx)];
  }
  if (msg.type === 'dockerPoll') {
    // One-shot poll requested by the events stream — no tick involvement.
    const [next, fx] = _maybeFetch(slice);
    return [next, fx];
  }
  if (msg.type === 'dockerResult') {
    // Fold the fetched maps (or keep the prior ones on a failed fetch) and
    // clear the in-flight guard. Always repaint — the diff cache makes a
    // no-change repaint cheap.
    return [{
      ...slice,
      status: msg.status || slice.status,
      stats: msg.stats || slice.stats,
      inFlight: false,
    }, [{ type: 'render' }]];
  }
  if (msg.type === 'key') return _handleKey(msg, slice);
  return slice;
}

function _handleKey(msg, slice) {
  if (getFocus() !== 'containers') return slice;
  const item = _getItems(slice)[getSel('containers')];
  if (!item) return slice;
  if (msg.key === 'i') return [slice, [{ type: 'dockerExec', mode: 'inspect', item }]];
  if (msg.key === 't') return [slice, [{ type: 'dockerExec', mode: 'logs', item }]];
  if (msg.key === 's') return [slice, [{ type: 'dockerShell', item }]];
  return slice;
}

// dockerFetch: the polling effect. Runs the two docker queries off-tick,
// publishes the numeric hub series, and folds the string maps back via
// dockerResult. On failure it still dispatches dockerResult (no maps) so the
// inFlight guard always clears.
registerEffect('dockerFetch', () => {
  setImmediate(async () => {
    try {
      const containers = _containers();
      if (!containers.length) { dispatchMsg(wrap('docker', { type: 'dockerResult', status: {}, stats: {} })); return; }

      const status = {};
      const args = containers.map(JSON.stringify).join(' ');
      const inspectOut = await execAsync(
        `docker inspect -f "{{.Name}}\t{{.State.Status}}" ${args} 2>/dev/null`,
        { timeout: 5000 },
      );
      const seen = new Set();
      for (const line of inspectOut.split('\n').filter(Boolean)) {
        const [rawName, st] = line.split('\t');
        if (!rawName) continue;
        const name = unprefix(rawName);
        seen.add(name);
        status[name] = (st || '').trim() || 'unknown';
      }
      for (const name of containers) if (!seen.has(name)) status[name] = 'unknown';

      const stats = {};
      const running = containers.filter(c => status[c] === 'running');
      if (running.length) {
        const sargs = running.map(JSON.stringify).join(' ');
        const statsOut = await execAsync(
          `docker stats --no-stream --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" ${sargs} 2>/dev/null`,
          { timeout: 5000 },
        );
        const ts = Date.now();
        for (const line of statsOut.split('\n').filter(Boolean)) {
          const [name, cpu, mem] = line.split('\t');
          if (!name) continue;
          stats[name] = { cpu: (cpu || '').trim(), mem: (mem || '').trim() };
          // Publish a numeric sample each tick so the series advances even
          // when the formatted strings repeat; drops cheaply if unsubscribed.
          const memInfo = parseMem(stats[name].mem);
          hub.publish('docker.stats', name, {
            ts, cpu: parsePercent(stats[name].cpu), mem: memInfo.used, memLimit: memInfo.limit,
          });
        }
      }
      // Drop the hub series for any tracked container that isn't running now.
      for (const name of containers) if (!stats[name]) hub.delete('docker.stats', name);

      dispatchMsg(wrap('docker', { type: 'dockerResult', status, stats }));
    } catch (e) {
      console.error(`[docker:fetch] ${e.message}`);
      dispatchMsg(wrap('docker', { type: 'dockerResult' }));  // keep prior maps, clear inFlight
    }
  });
});

registerEffect('dockerEventsStart', () => {
  startEventsStream(getModel().config);
});

registerEffect('dockerExec', (eff) => {
  const q = JSON.stringify(eff.item);
  setActiveTab(0);
  leaveTerminalMode();
  if (eff.mode === 'inspect') {
    streamCommand(`inspect ${eff.item}`,
      `docker inspect ${q} 2>&1 | (command -v jq >/dev/null && jq . || cat)`);
  } else {
    streamCommand(`logs ${eff.item}`, `docker logs --tail=200 -f ${q} 2>&1`);
  }
});

registerEffect('dockerShell', (eff) => {
  const q = JSON.stringify(eff.item);
  // bash if present, else sh. (`exec bash || exec sh` keeps the interactive
  // prompt — readline writes it to stderr, which a 2>/dev/null would mute.)
  addEphemeralTab(
    getModel().currentGroup,
    `shell-${eff.item}`,
    `docker exec -it ${q} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`,
    `sh:${eff.item}`,
  );
});

// --- compose group actions ---
//
// Auto-generate docker compose actions for groups with a `compose:` field.
// Users override these by declaring same-named actions in YAML (YAML actions
// merge AFTER plugin/component actions).
function groupActions(group) {
  if (!group || !group.compose) return {};
  const f = group.compose;
  const flag = (f === 'docker-compose.yml' || f === 'compose.yml') ? '' : ` -f ${f}`;
  const c = `docker compose${flag}`;
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

// --- panel type: containers ---

/** Raw container names from the active group's config; filtering applied
 *  centrally by api.getItems. The row list is config-derived (the slice holds
 *  status/stats, not the names), so the slice param is unused here. */
function _getItems(/* slice */) {
  const m = getModel();
  const group = m.config.groups[m.currentGroup];
  return group ? (group.containers || []) : [];
}

function render(panel, width, height) {
  const m = getModel();
  const group = m.config.groups[m.currentGroup];
  if (!group) return '';
  const containers = apiGetItems('containers');
  const sel = getSel('containers');
  const isFocused = getFocus() === 'containers';
  const t = theme();
  const lines = containers.map((name, i) => {
    const isSel = i === sel && isFocused;
    // Phase 5 — status dot inlined (was a decorator handler). Plain text
    // on selected rows; colored markup otherwise (PRINCIPLES §8 — no [/]
    // in [reverse]).
    const st = _status(name);
    const dot = (st === 'running' || st === 'stopped' || st === 'exited') ? '●' : '○';
    const color = st === 'running' ? t.running
                : (st === 'stopped' || st === 'exited') ? t.stopped
                : t.unknown;
    const lhead = isSel ? `${dot} ` : `[${color}]${dot}[/] `;
    const gutter = isMultiSel('containers', name) ? '*' : ' ';
    if (isSel) return `[${t.selected}]${gutter}${lhead}${esc(name)}`;
    return `${gutter}${lhead}${esc(name)}`;
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

function getInfo(item) {
  if (!item) return [];
  const st = _status(item);
  const lines = [`[bold]${esc(item)}[/]`, '', `[dim]status:[/] ${st}`];
  const stats = _stats(item);
  if (stats) {
    lines.push(`[dim]cpu:[/] ${esc(stats.cpu)}`);
    lines.push(`[dim]mem:[/] ${esc(stats.mem)}`);
  }
  return lines;
}

function copyOptions(item) {
  if (!item) return [];
  const status = _status(item);
  const stats = _stats(item);
  const opts = [
    { label: `Container name: ${item}`, content: item },
    { label: `Status: ${status}`, content: status },
  ];
  if (stats) {
    opts.push({ label: `CPU: ${stats.cpu}`, content: stats.cpu });
    opts.push({ label: `Memory: ${stats.mem}`, content: stats.mem });
  }
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

// --- Bulk container commands (`:` cmdline mode) ---
//
// Each reads selectedOrFocused('containers') so the same invocation works
// on the multi-selected set OR the single focused row.
function bulkContainer(verb, opts = {}) {
  const desc = opts.desc ||
    `${verb[0].toUpperCase() + verb.slice(1)} selected (or focused) container(s)`;
  const cmdSuffix = opts.cmdSuffix || '';
  return {
    name: verb,
    desc,
    run: () => {
      const names = selectedOrFocused('containers');
      if (!names.length) return;
      const quoted = names.map(n => JSON.stringify(n)).join(' ');
      setActiveTab(0);
      leaveTerminalMode();
      const label = names.length === 1 ? `${verb} ${names[0]}` : `${verb} ${names.length} containers`;
      streamCommand(label, `docker ${verb} ${quoted}${cmdSuffix}`);
    },
  };
}

const containerCommands = [
  bulkContainer('stop'),
  bulkContainer('start'),
  bulkContainer('restart'),
  bulkContainer('inspect', {
    desc: 'Inspect selected (or focused) container(s) — read-only',
    cmdSuffix: ' 2>&1 | (command -v jq >/dev/null && jq . || cat)',
  }),
];

module.exports = {
  name: 'docker',
  init,
  update,
  // Framework teardown (cleanupComponents on quit) — stop the long-lived
  // `docker events` child + its reconnect timer. process.on('exit') backstops.
  cleanup: stopEventsStream,
  // statusFor: generic provider contract — lets the core groups renderer show
  // running/stopped without knowing docker exists. Reads the Component slice.
  statusFor: (name) => {
    const s = _slice();
    return (name in s.status) ? s.status[name] : null;
  },
  groupActions,
  commands: containerCommands,
  panelTypes: {
    containers: {
      render,
      getItems: (slice) => _getItems(slice),
      getInfo,
      copyOptions,
      keyHints: 'i inspect | t logs | s shell',
      filterable: true,
      filterText: name => name,
      idOf: name => name,
    },
  },
  // Test-only internals (events stream pure helpers + stat parsers + reducer).
  _handleEventLine: handleEventLine,
  _isTrackedContainer: isTrackedContainer,
  _stopEventsStream: stopEventsStream,
  _parseBytes: parseBytes,
  _parseMem: parseMem,
  _parsePercent: parsePercent,
  _init: init,
  _update: update,
};

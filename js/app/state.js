/**
 * App state — config loading, layout initialization, slice-reset wrappers.
 *
 * No mutable state lives here. The root model lives in runtime.js
 * (getModel()); Component slices live in the instance store
 * (panel/route.js). This module is the boot/init layer
 * (loadConfig + initState) plus the small set of read/write helpers the
 * rest of the codebase imports from `./state`: getSel / setSel /
 * getScroll / setScroll / toggleMultiSel / allPanels /
 * resetGroupContext / selectGroup / setViewerContent / appendViewerLines / recomputeGroups
 * (and friends).
 *
 * Helpers are thin routers: they resolve a panel type to its owning
 * Component, then dispatch a wrapped Msg into that Component's update.
 * The Component is the single writer for its slice.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { getModel } = require('../model/store');
const { rebuildLayoutFromConfig } = require('../leaves/wm/arrange');
const astatus = require('../leaves/text/action-status');
// Panel-state accessors (readers/writers/composites) moved to
// panel/nav-state.js in v0.6.5 §1 Phase 2. This module keeps the boot layer
// (loadConfig/initState) + the two dispatch-layer group helpers
// (selectGroup/resetGroupContext) and RE-EXPORTS the accessors below so
// existing `require('../app/state')` importers (notably the test suite) keep
// working untouched; new code imports them from panel/nav-state directly.
const navState = require('../panel/nav-state');


// #D13 (2026-06-18) — subscriptions as canonical `Model → Sub`. A Component
// exports a PURE `subscriptions(paneDef, model) → [descriptor]` declaring the
// ongoing sources it needs for the current state; the framework re-evaluates
// the WHOLE desired set each update (the post-dispatch finalizer calls
// `reconcileSubscriptions` via the injected hook), DIFFS it against the live
// set, and starts/stops the delta. Replaces the v0.6.4 Phase D mount-time
// wiring, which subscribed on pane-mint but never tore down (a disposed pane's
// topic leaked a live sub + a wasted repaint per publish). A pane leaving the
// layout — or a sub whose existence depends on model state — reconciles
// correctly: the desired set is recomputed and the gone source is stopped.
//
// v0.6.6 FIX-3 Phase 1 — the reconciler is KIND-DISPATCHED. Each descriptor
// carries a `kind`; the `_subKinds` registry maps kind → {normalize, key,
// start, stop}, so the diff loop is source-agnostic. Today only `hub` is
// registered (a pure refactor — bare `{topic, window}` descriptors default to
// the hub kind: `onUpdate` is a repaint, deduped by topic+window). Later phases
// register `interval` / `resize` / `process-stream` and an app-global
// `appSubscriptions(model)` source beside the per-pane component subs. See
// docs/v0.6.6.md §7.
//
// Memoized module refs (the reconciler runs per outermost dispatch; a fresh
// relative require() each time is the ~tens-of-µs/call fs cost paint.js's hot
// path also memoizes away). Cycle-safe: lazy + cached, like reconcilePaneInstances.
let _apiRef, _routeRef, _mpoolRef, _hubRef, _loopRef, _termRef, _paintRef, _dispatchRef, _historyRef, _diagRef, _jobsRef, _replayRef;
const _api = () => (_apiRef ||= require('../panel/api'));
const _route = () => (_routeRef ||= require('../panel/route'));
const _mpool = () => (_mpoolRef ||= require('../leaves/wm/pool'));
const _hub = () => (_hubRef ||= require('../leaves/infra/hub'));
const _history = () => (_historyRef ||= require('../feature/history'));
const _diag = () => (_diagRef ||= require('../io/diag-log'));
const _jobs = () => (_jobsRef ||= require('../feature/jobs'));
const _replay = () => (_replayRef ||= require('../dispatch/runtime/replay'));

// Live subscriptions: key → { kind, token }. The single source of what's
// currently running; the reconcile diff is computed against it. `stop` routes
// the token back through its kind handler.
const _liveSubs = new Map();

// PERF gate for reconcileSubscriptions — the last-reconciled snapshot of EVERY
// input the desired set depends on: the layout-slice fields (arrange, dims,
// viewMode, focus, halfView) plus the off-slice signals (jobsMode, diagLogMode,
// liveClock, dockerRefresh). The full key is built inline in reconcileSubscriptions
// (see the note there before adding a new dependency). An unchanged gate means the
// live set is already correct and the ~350µs desired-set rebuild+diff can be
// skipped. Reset to null by `_resetSubscriptions` so the next reconcile always runs.
let _lastSubGate = null;

// Sub-kind handler registry — how each kind of ongoing source is keyed,
// started, and stopped. The reconciler is kind-agnostic; new external-source
// kinds (interval / resize / process-stream — FIX-3 later phases) plug in here.
// `ctx` carries what a handler may use to feed events back into the loop
// (today: scheduleRender; later: dispatch / applyMsg).
const _subKinds = {
  // Hub topics (#D13). Bare `{topic, window}` descriptors; repaint on publish.
  hub: {
    normalize: (d) => (d && d.topic ? { topic: d.topic, window: d.window || 1 } : null),
    key: (d) => `${d.topic}:${d.window}`,
    start: (d, ctx) => _hub().subscribe(d.topic, { window: d.window, onUpdate: () => ctx.scheduleRender() }),
    stop: (token) => _hub().unsubscribe(token),
  },
  // Terminal resize (FIX-3 Phase 2) — the app-global SIGWINCH source. Was
  // tui.js's `process.stdout.on('resize')` listener. On each resize: refresh
  // io/term's COLS/ROWS mirror (footer/overlay/panel renderers still read
  // cols()/rows()), dispatch the `term_resized` layout Msg (lands dims in the
  // model — resize-as-Msg), and repaint. Singleton: one descriptor `{kind:'resize'}`.
  resize: {
    normalize: () => ({}),
    key: () => 'resize',
    start: (d, ctx) => {
      const onResize = () => {
        (_termRef ||= require('../io/term')).refreshSize();
        ctx.dispatch(ctx.wrap('layout', {
          type: 'term_resized',
          cols: process.stdout.columns || 80,
          rows: process.stdout.rows || 24,
        }));
        ctx.scheduleRender();
      };
      process.stdout.on('resize', onResize);
      return onResize;
    },
    stop: (onResize) => process.stdout.removeListener('resize', onResize),
  },
  // Recurring timer (FIX-3 Phase 3). Descriptor `{kind:'interval', id, ms, onTick}`.
  // `id` makes the key stable + unique per logical source so the reconciler
  // never restarts a live interval across dispatches. `onTick(ctx)` runs each
  // tick — the canonical Sub→Msg form is `(ctx) => ctx.dispatch(msg)`; the
  // overlay-repaint poll uses a direct paint. Self-re-arming setTimeout (NOT
  // setInterval) so a slow tick can't pile up, and `unref` so a pending tick
  // never holds the process open (clean teardown on quit + in tests).
  interval: {
    normalize: (d) => (d && d.id && d.ms > 0 && typeof d.onTick === 'function' ? d : null),
    key: (d) => `${d.id}:${d.ms}`,
    start: (d, ctx) => {
      let timer = null;
      let stopped = false;
      const tick = () => {
        if (stopped) return;
        try { d.onTick(ctx); } catch (e) { console.error(`[sub:interval:${d.id}] ${e && e.message}`); }
        timer = setTimeout(tick, d.ms);
        if (timer && timer.unref) timer.unref();
      };
      timer = setTimeout(tick, d.ms);
      if (timer && timer.unref) timer.unref();
      return () => { stopped = true; if (timer) clearTimeout(timer); };
    },
    stop: (cancel) => cancel(),
  },
  // Long-lived child process whose stdout lines are events (FIX-3 Phase 5).
  // Descriptor `{kind:'process-stream', id, cmd, args, stdio?, reconnectMs?, onLine, onStop?}`.
  // start spawns the child, splits stdout into lines → `onLine(line, ctx)`, and
  // auto-reconnects on exit OR spawn failure (backoff, unref'd — the T17 edge:
  // a missing binary still schedules a retry). stop kills the child + cancels a
  // pending reconnect + invokes the optional `onStop()` for consumer-side
  // cleanup (e.g. a line-debounce timer). The reconnect/buffer state lives in the TOKEN, never the
  // model. A spawned child does NOT die with the parent, so the Sub MUST be
  // stopped on quit (teardownSubscriptions, wired from the app boot).
  'process-stream': {
    normalize: (d) => (d && d.id && d.cmd && typeof d.onLine === 'function' ? d : null),
    key: (d) => d.id,
    start: (d, ctx) => {
      const { spawn } = require('child_process');
      const token = { proc: null, buf: '', reconnectTimer: null, stopped: false, onStop: d.onStop };
      const reconnect = () => {
        if (token.stopped || token.reconnectTimer) return;
        token.reconnectTimer = setTimeout(() => { token.reconnectTimer = null; launch(); }, d.reconnectMs || 5000);
        if (token.reconnectTimer.unref) token.reconnectTimer.unref();
      };
      const launch = () => {
        if (token.stopped) return;
        let proc;
        try { proc = spawn(d.cmd, d.args || [], { stdio: d.stdio || ['ignore', 'pipe', 'ignore'] }); }
        catch (e) { console.error(`[sub:process:${d.id}] spawn failed: ${e && e.message}`); reconnect(); return; }
        token.proc = proc; token.buf = '';
        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', (chunk) => {
          token.buf += chunk;
          let nl;
          while ((nl = token.buf.indexOf('\n')) >= 0) {
            const line = token.buf.slice(0, nl).trim();
            token.buf = token.buf.slice(nl + 1);
            if (line) { try { d.onLine(line, ctx); } catch (e) { console.error(`[sub:process:${d.id}] onLine: ${e && e.message}`); } }
          }
        });
        proc.on('exit', () => { if (token.proc === proc) token.proc = null; if (!proc.killed && !token.stopped) reconnect(); });
        proc.on('error', (e) => console.error(`[sub:process:${d.id}] stream error: ${e && e.message}`));
      };
      launch();
      return token;
    },
    stop: (token) => {
      token.stopped = true;
      if (token.reconnectTimer) { clearTimeout(token.reconnectTimer); token.reconnectTimer = null; }
      if (token.proc) { try { token.proc.kill(); } catch (_) { /* already dead */ } token.proc = null; }
      // Optional consumer-side cleanup on teardown (e.g. docker cancels its
      // line-debounce timer so a pane-remove mid-window can't fire one stray
      // poll after the stream is gone).
      if (typeof token.onStop === 'function') { try { token.onStop(); } catch (_) { /* best-effort */ } }
    },
  },
  // Mirror a module-local live store into the model (v0.6.6 FIX-1). Descriptor
  // `{kind:'store-mirror', id, store, msgType, field}` — `store` is the
  // mirrorable-store contract `{snapshot(), setOnChange(cb)}` (docs/v0.6.6.md
  // §8.1). The store fires its injected `cb` on each mutation; `cb` applyMsg's a
  // whole-snapshot `{type: msgType, [field]: store.snapshot()}`, the reducer's
  // *_synced arm lands it on `model[field]`, and render reads `model[field]` —
  // so the frame is f(model) (#D5) instead of reading the off-model store live.
  // The store imports NO dispatch (cb is injected); this keeps the feature/io
  // layer below dispatch. Does NOT prime synchronously: `start` runs inside the
  // reconciler BEFORE `_liveSubs.set`, so a nested dispatch would re-enter
  // reconcile and re-start this same sub (recursion) — instead the model field
  // is seeded `[]` in store.init() (mirrors the store's empty boot state) and
  // the cb drives every update from there.
  'store-mirror': {
    normalize: (d) => (d && d.id && d.msgType && d.field && d.store
      && typeof d.store.snapshot === 'function'
      && typeof d.store.setOnChange === 'function' ? d : null),
    key: (d) => d.id,
    start: (d, ctx) => {
      d.store.setOnChange(() => ctx.applyMsg({ type: d.msgType, [d.field]: d.store.snapshot() }));
      return d.store;
    },
    stop: (store) => store.setOnChange(null),
  },
  // Throttled snapshot-mirror of a hub metrics topic into model.metrics[topic]
  // (v0.6.6 Finding B). Descriptor `{kind:'metrics-mirror', topic, window, ms?}`.
  // This is the canonical TEA shape for a HIGH-FREQUENCY external source feeding
  // a DERIVED VIEW (a graph): SAMPLE at a bounded cadence, not once per event
  // (the throttle-the-subscription pattern TEA prescribes for fast sources — the
  // same shape as a frame-rate / time-sampled subscription). Contrast the
  // `store-mirror` kind, which fires per mutation: correct for DISCRETE
  // low-frequency stores (jobs/diag/history), but for a continuous sampler it
  // would re-introduce exactly the per-publish dispatch the hub's #D17 removed.
  // Mechanism: subscribe to the hub (so it RETAINS `window` samples) and, on each
  // publish, schedule ONE trailing sample `ms` later that mirrors hub.matrix(topic)
  // → a `metrics_synced` Msg; a burst of publishes coalesces to one dispatch per
  // `ms`. Keyed by topic — multiple consumer panes on one topic share a single
  // mirror. Render reads model.metrics[topic] (frame = f(model), #D5). Poll-driven
  // producers (docker's 10s loop) ride this as a low-rate stream; future push
  // sources slot in unchanged. See docs/v0.6.6.md §9.
  'metrics-mirror': {
    normalize: (d) => (d && d.topic ? { topic: d.topic, window: d.window || 40, ms: d.ms || 250 } : null),
    key: (d) => d.topic,
    // Two panes on the same topic share ONE mirror (it writes the single
    // model.metrics[topic] field) — coalesce to the LARGEST window so the
    // wider-history pane isn't starved, and the tightest cadence. Each pane
    // still slices its own `window` from the shared series at render.
    merge: (a, b) => ({ topic: b.topic, window: Math.max(a.window, b.window), ms: Math.min(a.ms, b.ms) }),
    start: (d, ctx) => {
      const token = { hubToken: null, timer: null, stopped: false };
      const sample = () => {
        token.timer = null;
        if (token.stopped) return;
        const hub = _hub();
        const series = {};
        for (const [rk, rows] of hub.matrix(d.topic, d.window)) series[rk] = rows;
        ctx.applyMsg({ type: 'metrics_synced', topic: d.topic, series, schema: hub.schema(d.topic) || { columns: {} } });
      };
      const schedule = () => {
        if (token.stopped || token.timer) return;          // coalesce a burst → one sample
        token.timer = setTimeout(sample, d.ms);
        if (token.timer.unref) token.timer.unref();         // a pending sample never holds the process open
      };
      token.hubToken = _hub().subscribe(d.topic, { window: d.window, onUpdate: schedule });
      return token;
    },
    stop: (token) => {
      token.stopped = true;
      if (token.timer) { clearTimeout(token.timer); token.timer = null; }
      if (token.hubToken != null) _hub().unsubscribe(token.hubToken);
    },
  },
  // Headless metrics PRODUCER (docs/metrics-producer.md). Descriptor
  // `{kind:'metrics-poll', id, topic, cmd, interval?, timeout?, focus_gate?, extract, schema?}`.
  // Sourced app-globally from config.metrics (_appSubscriptions) — decoupled
  // from any pane, unlike docker's per-pane poll. `start` announces the topic
  // schema once, then self-rearms `execAsync(cmd)` off-tick every `interval`,
  // runs the pure extractor over stdout, and publishes each row to the hub; the
  // existing `metrics-mirror` (declared by a stats pane) samples it into the
  // model. Discipline (docker-style): polls are strictly SEQUENTIAL — the next
  // timer arms only after the current poll completes, so the gap between polls is
  // `interval` (+ exec time); an `inFlight` latch guards re-entry belt-and-braces.
  // Timers are `unref`'d + tracked so stop() cancels them and none holds the loop
  // open. abort-on-stop kills an in-flight child via execAsync's signal. Per-row
  // GC hub.delete's a rowKey absent from a SUCCESSFUL tick — but an empty/failed
  // poll (execAsync resolves '' on timeout/error) is NOT read as "all rows gone":
  // it keeps prior data, so one blip can't wipe the graph (docker's dropStale).
  // Skips the exec while backgrounded (focus_gate, default on) or replaying (the
  // fold is synchronous so a macrotask poll can't fire mid-fold anyway — the guard
  // is defensive, matching the overlay-repaint sub).
  'metrics-poll': {
    normalize: (d) => (d && d.id && d.topic && d.cmd && d.extract && typeof d.extract === 'object' ? d : null),
    key: (d) => d.id,
    start: (d, ctx) => {
      const { execAsync } = require('../io/exec');
      const { extract } = require('../leaves/metrics/extract');
      const hub = _hub();
      const cols = (d.schema && d.schema.columns) || {};
      // `counter` columns are monotonic tallies (net/disk byte counters): the
      // producer publishes their per-second RATE and advertises them to consumers
      // as `rate` (B/s). Rewrite the schema for defineTopic; the extractor still
      // sees the raw `counter` type in `cols` (parsed as a plain number).
      const counterFields = Object.keys(cols).filter(f => cols[f] && cols[f].type === 'counter');
      const pubSchema = counterFields.length
        ? { ...(d.schema || {}), columns: Object.fromEntries(Object.entries(cols).map(
            ([f, c]) => [f, (c && c.type === 'counter') ? { ...c, type: 'rate' } : c])) }
        : (d.schema || {});
      hub.defineTopic(d.topic, pubSchema);
      const ms = (typeof d.interval === 'number' && d.interval > 0) ? d.interval : 2000;
      const timeout = (typeof d.timeout === 'number' && d.timeout > 0) ? d.timeout : Math.min(ms, 5000);
      // token.prev: rowKey -> { sample: RAW counters, t: Date.now() } — kept for
      // rate derivation across polls AND for row GC (via keys()).
      const token = { timer: null, stopped: false, inFlight: false, prev: new Map(), ac: null };
      const schedule = () => {
        if (token.stopped || token.timer) return;
        token.timer = setTimeout(poll, ms);
        if (token.timer.unref) token.timer.unref();
      };
      const poll = async () => {
        token.timer = null;
        if (token.stopped) return;
        // Skip the exec while backgrounded or replaying; still reschedule so
        // polling resumes when focus returns / the fold ends. getModel() read
        // LIVE (the tick fires after the declaring model is stale — the same
        // blessed live-read the overlay-repaint / clock Subs use).
        const skip = (d.focus_gate !== false && getModel().focused === false) || _replay().isReplaying();
        if (!token.inFlight && !skip) {
          token.inFlight = true;
          token.ac = new AbortController();
          try {
            const out = await execAsync(d.cmd, { signal: token.ac.signal, timeout });
            if (!token.stopped) {
              const rows = extract(out, d.extract, cols);
              // execAsync never rejects — a timeout, non-zero exit, or blip
              // resolves as '' → extract() = []. Do NOT read that as "all rows
              // vanished" and wipe the topic: only publish + GC when we actually
              // parsed rows; an empty poll leaves prior data + history intact
              // (docker's dropStale keeps prior maps on a bad fetch).
              if (rows.length) {
                const now = Date.now();
                const seen = new Map();
                for (const { rowKey, sample } of rows) {
                  let outSample = sample;
                  if (counterFields.length) {
                    // Derive per-second rates for counter fields from the prior
                    // RAW sample; publish those in place of the raw tally.
                    outSample = { ...sample };
                    const prev = token.prev.get(rowKey);
                    const dt = prev ? (now - prev.t) / 1000 : 0;
                    for (const f of counterFields) {
                      const cur = sample[f];
                      const pv = prev && prev.sample ? prev.sample[f] : undefined;
                      const delta = cur - pv;
                      // First sample, non-monotonic (counter reset/wrap), or zero
                      // dt → no rate this tick (renders '—').
                      outSample[f] = (prev && dt > 0 && Number.isFinite(cur) && Number.isFinite(pv) && delta >= 0)
                        ? delta / dt : NaN;
                    }
                  }
                  hub.publish(d.topic, rowKey, outSample);
                  seen.set(rowKey, { sample, t: now });   // RAW counters for the next delta
                }
                for (const rk of token.prev.keys()) if (!seen.has(rk)) hub.delete(d.topic, rk); // GC vanished rows
                token.prev = seen;
              }
            }
          } catch (e) {
            if (!token.stopped) console.error(`[metrics:${d.topic}] ${e && e.message}`);
          } finally { token.inFlight = false; token.ac = null; }
        }
        schedule();
      };
      // First poll ASAP (not after `interval`). Tracked + unref'd like every
      // other timer here so stop() can cancel it and it never holds the loop open.
      token.timer = setTimeout(poll, 0);
      if (token.timer.unref) token.timer.unref();
      return token;
    },
    stop: (token) => {
      token.stopped = true;
      if (token.timer) { clearTimeout(token.timer); token.timer = null; }
      if (token.ac) { try { token.ac.abort(); } catch (_) { /* nothing in flight */ } }
    },
  },
};

// True while a streamed action is running AND the live action-status chip is
// enabled — the arming condition for the frame clock (so the on-border
// duration/spinner advances mid-run). Pure projection; no wall-clock read.
function _liveActionStatus(model) {
  if (!model || !Array.isArray(model.jobs) || !model.jobs.length) return false;
  const cfg = astatus.resolveConfig(model.config && model.config.action_status);
  if (!cfg.enabled || !cfg.live) return false;
  return model.jobs.some((j) => j.status === 'running'
    && (j.kind === 'stream-routed' || j.kind === 'stream-unrouted'));
}

// App-global subscriptions — ongoing sources not owned by any pane. Pure
// projection of the model, merged into the per-pane component subs by
// `_desiredSubs`. (FIX-3: resize [always]; terminal-overlay poll [Phase 3,
// while a terminal tab is on-screen]; frame clock [Phase 6, while an age
// overlay is open or a live action-status chip is running].)
function _appSubscriptions(model) {
  const subs = [{ kind: 'resize' }];
  // #D15 terminal-overlay repaint backstop — only WHILE a terminal tab is
  // on-screen (FIX-3 Phase 3). The off-model PTY/xterm buffer (#D14) has async
  // race windows the event-driven repaints (PTY write / tab-activation / any
  // dispatch) miss; this is the eventual-consistency poll. Was tui.js's
  // always-on `setInterval(renderTerminalOverlay, 250)` — now a model-conditional
  // Sub: the timer EXISTS only while a terminal tab is active (the reconciler
  // starts it on activation, stops it on switch-away), instead of running idle
  // forever. `onTick` reads getModel() LIVE (ticks fire 250ms later, after the
  // declaring model is stale). Guarded by smoke/pty-overlay.
  if (_termTabOnScreen()) {
    subs.push({
      kind: 'interval', id: 'overlay-repaint', ms: 250,
      // Skip under replay: the controller schedules a FULL render on every seek/
      // play tick, and the live-PTY async race this poll backstops (#D14/#D15)
      // can't occur against PTY-less replay screens — so the tick is pure
      // redundancy during a fold. (The Sub itself stays declared; the finalizer
      // skips sub-reconcile under replay, so this is the cheap in-tick guard.)
      onTick: () => {
        if (_replay().isReplaying()) return;
        (_paintRef ||= require('../render/paint')).renderTerminalOverlay(getModel());
      },
    });
  }
  // Frame clock (model.now) — ticks ONLY while an age overlay (jobs/diag) is
  // open OR a stream action is running with a live action-status chip on
  // screen, so an idle TUI emits no ticks and the replay log stays quiet (FIX-3
  // Phase 6; was the arm_clock self-re-arm gated on model.clockArmed). onTick
  // reads the wall clock in the shell (blessed exc. C) and applyMsg's a flat
  // `clock_tick` carrying the fresh `now`. The action-status arm tears down
  // when the last stream job ends (the chip's FINAL stamp uses endedAt, not
  // now, so it's correct with or without the tick — the tick only makes the
  // mid-run duration/spinner advance between output chunks).
  const overlayClock = model && model.modes && (model.modes.jobsMode || model.modes.diagLogMode);
  if (overlayClock || _liveActionStatus(model)) {
    subs.push({
      kind: 'interval', id: 'clock', ms: 1000,
      onTick: (ctx) => ctx.applyMsg({ type: 'clock_tick', now: Date.now() }),
    });
  }
  // FIX-1 — mirror the module-local live stores into the model so render reads
  // model.{history,…} (frame = f(model), #D5). Always-active: the model must
  // always reflect the store. The store-mirror kind injects a cb that dispatches
  // a whole-snapshot `*_synced` Msg on each store mutation; the store imports no
  // dispatch (the {snapshot, setOnChange} contract — docs/v0.6.6.md §8.1).
  subs.push({
    kind: 'store-mirror', id: 'history',
    store: _history(), msgType: 'history_synced', field: 'history',
  });
  subs.push({
    kind: 'store-mirror', id: 'diag',
    store: _diag(), msgType: 'diag_synced', field: 'diagLog',
  });
  subs.push({
    kind: 'store-mirror', id: 'jobs',
    store: _jobs(), msgType: 'jobs_synced', field: 'jobs',
  });
  // Headless hub producers (docs/metrics-producer.md) — one `metrics-poll` Sub
  // per top-level `metrics:` entry. App-global (not pane-owned): a producer
  // runs whenever it's declared, decoupled from whether a consumer pane is
  // placed (a topic with no subscriber drops its publishes cheaply). Config is
  // genuinely boot-immutable — there is NO live config reload (edit.js: "no live
  // reload — deliberate"; `:restore-layout` rebuilds arrange from the already-
  // loaded config), so this projection is stable after boot and the gate's
  // omission of `config.metrics` is safe. NOTE the asymmetry with docker: docker
  // rides the `arrange` ref because it's a PLACED pane; a metrics producer is
  // headless, so if live config reload is ever added, `config.metrics` (and a
  // future live rate-step's ms) MUST be folded into `_lastSubGate` (§7) — an
  // arrange rebuild alone would not pick up an added/removed producer.
  // Spread `def` first so the framework-owned kind/id/topic always win.
  const producers = (model && model.config && model.config.metrics) || {};
  for (const [topic, def] of Object.entries(producers)) {
    if (!def || typeof def !== 'object') continue;
    subs.push({ ...def, kind: 'metrics-poll', id: `metrics:${topic}`, topic });
  }
  return subs;
}

// Is the active viewer showing a terminal tab? Decides whether the #D15 overlay
// poll is desired. Defensive try/catch: early boot / unit setups without a
// resolvable detail slice answer "no" (so the poll isn't declared there).
function _termTabOnScreen() {
  // U2d — any terminal surface on screen (the legacy viewer terminal tab OR a
  // minted `terminal` pane), via the shared selector the overlay also reads, so
  // the poll's "should I exist" gate and the overlay's "what do I paint" list
  // can't disagree.
  try { return require('../panel/terminal-surfaces').visibleTerminalSurfaces(getModel()).length > 0; }
  catch (_) { return false; }
}

// Pure projection: the DESIRED subscription set for the current state. Walks the
// placed panes (layout arrange) and asks each pane's Component for its declared
// subs, passing the root `model` so a sub can depend on model state (canonical
// Model → Sub). Returns Map "<kind>:<handler key>" → { kind, desc }.
function _desiredSubs(model) {
  const out = new Map();
  // App-global sources first (resize today), then per-pane component subs.
  for (const d of _appSubscriptions(model)) _addDesired(out, d);
  const components = _api()._components ? _api()._components() : null;
  if (!components) return out;
  const arrange = _layoutSlice() && _layoutSlice().arrange;
  const placed = arrange ? _mpool().allPanesInColumns(arrange) : [];
  for (const p of placed) {
    const comp = components[_route().componentForPanel(p.type)];
    if (!comp || typeof comp.subscriptions !== 'function') continue;
    let descriptors;
    try { descriptors = comp.subscriptions(p, model) || []; }
    catch (e) { console.error(`[${comp.name || '?'}] subscriptions() threw: ${e && e.message}`); continue; }
    for (const d of descriptors) _addDesired(out, d);
  }
  return out;
}

// Normalize + key one descriptor through its kind handler into the desired-set.
// Bare `{topic, window}` (no `kind`) = the hub kind (back-compat). Unknown kinds,
// or descriptors a kind rejects (e.g. hub without a topic), are skipped. Keyed
// `<kind>:<handler key>` so kinds never collide on a shared key. (FIX-3
// app-global subs will route through here from an appSubscriptions(model) source
// too.)
function _addDesired(out, d) {
  if (!d) return;
  const kind = d.kind || 'hub';
  const h = _subKinds[kind];
  if (!h) { console.error(`[subscriptions] unknown sub kind: ${kind}`); return; }
  const desc = h.normalize ? h.normalize(d) : d;
  if (!desc) return;
  // Same key already desired? A kind may define `merge` to coalesce the two
  // descriptors (e.g. metrics-mirror takes the max window); otherwise
  // last-write wins (the prior behavior).
  const key = `${kind}:${h.key(desc)}`;
  const prior = out.get(key);
  out.set(key, { kind, desc: (prior && h.merge) ? h.merge(prior.desc, desc) : desc });
}

// The docker container-poll cadence — a service-slice field (config-seeded,
// stepped by the refresh control). docker's `subscriptions()` reads it live, so
// it is a gate input (the INVARIANT below); undefined when docker isn't placed →
// a stable value that never trips the gate.
function _dockerRefreshMs() {
  const s = _api().serviceSlice('docker');
  return s ? s.refreshMs : undefined;
}

// Reconcile the live subscriptions to match `_desiredSubs(model)`: start the
// newly-desired, stop the no-longer-desired, each routed through its kind
// handler. Called by the dispatch finalizer each outermost dispatch (#D13); the
// diff makes it a no-op when the desired set is unchanged (the common case) —
// so a live source is NOT torn down + restarted while its key is stable.
function reconcileSubscriptions(model) {
  // PERF gate — the DESIRED subscription set is a pure function of the LAYOUT
  // (arrange = which panes are placed + each pane's `subscriptions()`; dims +
  // viewMode = the on-screen-terminal check that gates the #D15 overlay poll)
  // plus the two mode flags that toggle the clock sub. Everything else desired is
  // constant (resize + the 3 store-mirrors) or immutable-post-boot (docker's
  // `_containers()` config gate — config is boot-immutable, there's no live
  // reload; docker rides the arrange ref as a PLACED pane). So when none of these changed since the last
  // reconcile, the desired set is unchanged and the live subs are already correct
  // — skip the desired-set rebuild + diff (~350µs/dispatch, dominated by the
  // `visibleTerminalSurfaces` on-screen check + the per-pane walk). This was
  // ungated (a per-keystroke cost on ANY booted layout).
  //   INVARIANT: if a future component's `subscriptions()` starts depending on
  // OTHER volatile model state, add that input to the gate key here (else the sub
  // won't start/stop correctly). stats keys on paneDef only. The app-global
  // `clock` sub keys on `_liveActionStatus(model)` (a running stream job +
  // action_status config) — NOT part of the layout slice — so it is folded into
  // the gate below; without it the live status clock would never arm on job
  // start / tear down on job end. docker's poll interval keys on the owner
  // slice's `refreshMs` (the refresh control mutates it) — also NOT in the layout
  // slice, so `dockerRefresh` is folded in too; without it a rate change would
  // not re-arm the `interval` Sub.
  //   TRIGGER (not just key): this reconcile only RUNS from finalizeDispatch,
  // which on the root lane fires when arrange/nav OR the `model.jobs` ref
  // changed across the dispatch (loop.js applyMsg gate). A job's lifecycle
  // arrives as `jobs_synced` (root lane, no arrange/nav move), so the jobs-ref
  // check there is what triggers this reconcile on job start/end — the gate key
  // below then decides whether the desired set actually changed.
  const ls = _layoutSlice();
  const modes = (model && model.modes) || {};
  const jobsMode = !!modes.jobsMode, diagLogMode = !!modes.diagLogMode;
  const liveClock = _liveActionStatus(model);
  const dockerRefresh = _dockerRefreshMs();
  // `focus` + `halfView` are gate inputs too: the app-global overlay-repaint sub
  // arms only when a terminal is ON SCREEN (visibleTerminalSurfaces), and that set
  // follows `slice.focus` in full view and `slice.halfView` in half view. The
  // isolable leak is HALF view: `view_place_pane` swaps a terminal out of a slot
  // WITHOUT touching `arrange`, so the pre-gate skipped and the 250ms poll ran on
  // with no terminal on screen (the idle-forever waste #D15 removed). A focus
  // change usually also rebuilds `arrange` (so it self-healed), but full-view
  // visibility follows focus, so it belongs in the key for correctness too. Both
  // are replaced by-ref on change, so `===` detects it; both are layout-slice
  // fields (unlike liveClock/dockerRefresh, folded in above from OUTSIDE it).
  const g = _lastSubGate;
  if (g && ls && g.arrange === ls.arrange && g.dims === ls.dims
        && g.viewMode === ls.viewMode && g.jobsMode === jobsMode && g.diagLogMode === diagLogMode
        && g.liveClock === liveClock && g.dockerRefresh === dockerRefresh
        && g.focus === ls.focus && g.halfView === ls.halfView) {
    return;   // desired set unchanged → live subs already correct
  }
  _lastSubGate = ls
    ? { arrange: ls.arrange, dims: ls.dims, viewMode: ls.viewMode, jobsMode, diagLogMode, liveClock, dockerRefresh, focus: ls.focus, halfView: ls.halfView }
    : null;
  const ctx = _subCtx();
  const desired = _desiredSubs(model);
  // stop — live sources no longer desired (e.g. a disposed pane's sub).
  for (const [key, live] of _liveSubs) {
    if (!desired.has(key)) { _subKinds[live.kind].stop(live.token); _liveSubs.delete(key); }
  }
  // start — desired sources not yet live.
  for (const [key, { kind, desc }] of desired) {
    if (_liveSubs.has(key)) continue;
    _liveSubs.set(key, { kind, token: _subKinds[kind].start(desc, ctx) });
  }
}

// The handler context — what a kind's `start` may use to feed its source back
// into the loop. Today just `scheduleRender` (the hub kind's repaint-on-publish).
// FIX-3 later phases add `dispatch` / `applyMsg` for interval/resize/process.
function _subCtx() {
  const api = _api();
  return {
    scheduleRender: api.scheduleRender,
    wrap: api.wrap,
    // dispatch = the wrapped-Msg pump (Component Msgs); applyMsg = the root
    // pump (flat root-reducer Msgs, e.g. clock_tick).
    dispatch: (msg) => (_loopRef ||= require('../dispatch/runtime/loop')).dispatchMsg(msg),
    applyMsg: (msg) => (_dispatchRef ||= require('../dispatch/control/dispatch')).applyMsg(msg),
  };
}

// Test-only — tear down every live sub + clear the ledger (mirrors hub._reset /
// jobs._reset), so a test starts from a clean subscription set.
function _resetSubscriptions() {
  for (const { kind, token } of _liveSubs.values()) _subKinds[kind].stop(token);
  _liveSubs.clear();
  _lastSubGate = null;   // force the next reconcile to rebuild (live set was cleared)
}

// --- Component slice resolution ---
//
// Lazy auto-register covers tests that touch state without explicit
// Component setup; production registers detail + groups + layout at
// boot via tui.js, so these only trip in the test harness.
// (U2f — `_detailSlice` retired with the `detail`/viewer Component. The content
// slot is a position-tab container of `info` + `text-view` instances now; nothing
// reads a kind-level `detail` slice.)

let _groupsAutoRegistered = false;
function _groupsSlice() {
  const api = require('../panel/api');
  // primarySliceOf for the same reason as _detailSlice — and this one
  // IS hit post-mint in production: initState calls _groupsSlice()
  // right after the mint loop disposed the 'groups' seed.
  let s = api.primarySliceOf('groups');
  if (!s) {
    if (!_groupsAutoRegistered) {
      try { require('../dispatch/runtime/effects').installBuiltins(); } catch (_) {}
      _groupsAutoRegistered = true;
    }
    _layoutSlice();   // layout must register first — focus reader's service slot
    api.registerComponent(require('../panel/navigator/groups'));
    s = api.primarySliceOf('groups');
  }
  return s;
}

// Same lazy-auto-register pattern for the layout (chrome) Component.
// The "first-touch" point is initState (sets initial focus + viewMode
// tag), so the helper is called there.
let _layoutAutoRegistered = false;
function _layoutSlice() {
  const api = _api();   // cached ref — a fresh relative require() here is ~70µs,
                        // and this sits on the per-dispatch sub-reconcile gate path.
  // layout is a SERVICE slot (chrome Component) — explicit read.
  let s = api.serviceSlice('layout');
  if (!s) {
    if (!_layoutAutoRegistered) {
      try { require('../dispatch/runtime/effects').installBuiltins(); } catch (_) {}
      _layoutAutoRegistered = true;
    }
    api.registerComponent(require('../panel/layout'));
    s = api.serviceSlice('layout');
  }
  return s;
}

// --- Config loading ---

function loadConfig(configPath) {
  // Global user config (~/.config/lazytui/config.yml, docs/global-config) —
  // loaded FIRST and layered under the project config BEFORE the set_config
  // Msg, so the recorded Msg carries the merged result (replay never
  // re-reads the file). Tolerant: missing = fine; broken = warning +
  // project-only.
  const g = require('../parser/global');
  const glob = g.loadGlobal(process.env);
  const ext = path.extname(configPath);
  let config;
  if (ext === '.json') {
    // JSON configs are the RESOLVED shape (parse()'s output form), so the
    // global raw sections merge post-hoc. Keyed sections layer as usual;
    // the wholesale scalars (theme/selection/editor) apply only when the
    // key is ABSENT — true for hand-authored JSON that omits them, never
    // for parse-resolved JSON (parse always emits them, defaults included).
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config = g.mergeGlobal(config, glob.config);
  } else {
    // In-process JS parser — was an out-of-process `python -m parser`
    // call until the parser was rewritten in JS. Errors thrown by
    // parse() are ParseError subclasses with composed messages; let
    // them propagate so tui.js's top-level handler prints them and
    // exits non-zero (mirrors the old "parser: <msg>" stderr line).
    // The global sections merge INSIDE parse (pre-validation) so
    // theme/selection defaulting applies to the merged result.
    const { parse } = require('../parser');
    config = parse(path.resolve(configPath), { global: glob.config });
  }
  if (glob.warnings.length) {
    config = { ...config, warnings: [...(config.warnings || []), ...glob.warnings] };
  }
  // v0.6.3 Phase D3 — route the root-model write through a Msg so
  // the reducer is the sole writer to model.config / projectDir /
  // configPath. Pre-D3 was direct `m.config = ...` (the BLESSED
  // outside-writer per docs/v0.5-layering.md §5).
  require('../dispatch/control/dispatch').applyMsg({
    type: 'set_config',
    config,
    configPath: path.resolve(configPath),
    // #D9 — resolve the config-status owner here (impure shell) so the
    // reducer's set_config arm stays pure of the ownership registry.
    csOwner: require('../panel/route').componentForPanel('config-status'),
  });
}

// --- Layout initialization ---

// Mint/dispose per-pane Component instances to MATCH the placed layout. Runs
// at boot (initState) AND after every runtime placement/removal — the dispatch
// finalizer calls it (via api.setInstanceReconciler) gated on arrange-ref
// change. MINT: each placed pane lacking an instance, keyed by paneId — so a
// second same-kind pane added at runtime (pool_show / pool-drag / pane-select)
// gets its OWN slice instead of collapsing onto the kind primary (the v0.6.4
// multi-viewer guarantee, previously honored only for config-declared panes).
// DISPOSE: each per-pane instance whose pane left the layout (frees the slice).
// This IS the framework's impure first-touch shell — getModel() is blessed
// here, as it was in the boot mint loop; the reducer arms that place/remove
// panes stay pure.
function reconcilePaneInstances() {
  const api = require('../panel/api');
  const route = require('../panel/route');
  const mpool = require('../leaves/wm/pool');
  const components = api._components ? api._components() : null;
  if (!components) return;
  const arrange = _layoutSlice().arrange;
  const placedPanes = arrange ? mpool.allPanesInColumns(arrange) : [];

  // MINT — resolve panes via the panel-type ownership registry (covers aliased
  // types like `file-browser`, owned by `files`). Deliberately NOT
  // `components[kind]`: that matched Component NAMES too, so a `type: docker`
  // pane disposed the kind-global service instance (its content owner). A
  // name-only kind mints nothing (honest unknown-type failure).
  // U2b P1 (K3) — MINT one instance per TAB (a slot hosts N tab-instances, one
  // active). tabInstId = newPaneId(tab.poolId); the tab's kind is its OWN pool
  // entry type (this fixes cross-kind multi-tab panes — each tab gets its own
  // slice shape). init receives the COLUMN paneId (slice.paneId self-identity for
  // geometry), while the instance is KEYED by tabInstId — equal for a single-tab
  // pane, so byte-identical there. `getInstance` is used (literal) for the
  // concrete-id existence checks — `hasInstance` now resolves paneId→active-tab.
  const mpane = require('../leaves/wm/pane');
  const placedInstIds = new Set();
  const activeMap = Object.create(null);
  for (const p of placedPanes) {
    const paneId = p.paneId;
    if (!paneId) continue;
    const tabs = (Array.isArray(p.tabs) && p.tabs.length) ? p.tabs : [{ id: p.id, poolId: p.id }];
    for (const tab of tabs) {
      const poolId = tab.poolId;
      if (!poolId) continue;
      const entry = (arrange.pool && arrange.pool[poolId]) || null;
      const kind = entry ? entry.type : p.type;
      if (!kind) continue;
      const tabInstId = mpane.newPaneId(poolId);
      const comp = components[route.componentForPanel(kind)];
      if (!comp) continue;
      // Dispose the kind-keyed registry seed (minted at registerComponent) on the
      // first per-tab mint; service slots are skipped (dispose refuses them anyway).
      if (route.getInstance(kind) && kind !== tabInstId && !route.isService(kind)) {
        route.disposeInstance(kind);
      }
      if (!route.getInstance(tabInstId)) {
        // init-injection (v0.6.4 #4): thread the seed facts init would reach for
        // as globals — init is a pure fn of (paneId, seed). seed.paneDef is the
        // PLACED PANE `p` for a DECLARED tab: the parser HOISTS panel fields (e.g.
        // ports' select_from) onto the placed pane but keeps them nested in the
        // pool entry's `config`, and some inits read the hoisted form — so the pane
        // shape, not the raw pool entry, is the contract.
        //   U2f — but a RUNTIME-MINTED (transient) tab's init must see its OWN
        // entry's config: a content slot's stable `pane.type/config` is now `detail`
        // (kept by _rebuildLegacyFields), so `p.config` no longer mirrors the active
        // minted tab. A minted content tab seeds its initial content via the mint's
        // `config.lines` (content-tab.js) which text-view.init reads from
        // seed.paneDef.config — so thread the tab's own entry for transient tabs
        // (else the nested jobs-cascade job-info card renders empty). Transient
        // entries are self-contained (no parser hoisting), so this is safe.
        const m = getModel();
        const seedPaneDef = (entry && entry.transient)
          ? { ...p, id: entry.id, type: entry.type, config: entry.config || {} }
          : p;
        const seed = { config: m.config, projectDir: m.projectDir, paneDef: seedPaneDef };
        route.setInstance(tabInstId, kind, comp.init(paneId, seed));
        route.setInstancePaneId(tabInstId, paneId);
      }
      placedInstIds.add(tabInstId);
    }
    // The slot's active instance = its activeTab's tab-instance.
    const activeId = p.activeTabId || (tabs[0] && tabs[0].id) || p.id;
    activeMap[paneId] = mpane.newPaneId(activeId);
    // (#D13 — hub subscriptions reconcile against the whole desired set each
    // dispatch via reconcileSubscriptions; a disposed pane's sub is torn down.)
  }
  route.setActiveInstanceMap(activeMap);

  // DISPOSE — tab-instances whose tab/pane is no longer placed. Skip service
  // slots (route refuses) and kind-seed singletons (id === kind: docker-style
  // panelTypes content owners + un-replaced registry seeds — not placed panes).
  const orphans = [];
  route.eachInstance(inst => {
    if (inst.service || inst.id === inst.kind) return;
    if (!placedInstIds.has(inst.id)) orphans.push({ id: inst.id, kind: inst.kind });
  });
  if (orphans.length) {
    // C5 — abort a removed pane's in-flight keyed compute (config-status' slow
    // git status/diff) so it doesn't run/land into a disposed instance. Keys
    // are tied to the instance id (see config-status' cfgStatusCompute/Diff
    // emits); cancelEffect no-ops if the key isn't live (the common case).
    // Docker's fetch is service-owned (skipped above), aborted only at quit.
    const effects = require('../dispatch/runtime/effects');
    for (const { id, kind } of orphans) {
      effects.cancelEffect(`cfgStatus:compute:${id}`);
      effects.cancelEffect(`cfgStatus:diff:${id}`);
      // U2d — a disposed `terminal` instance owns a live PTY keyed by its
      // instance id (== ptyId). This orphan scan is the ONLY place that learns a
      // terminal pane left the layout (a closed tab, a removed slot), so kill the
      // PTY here. Idempotent: destroySession no-ops on an unknown/dead id, so it
      // races safely with a concurrent clean-exit teardown.
      if (kind === 'terminal') {
        try { require('../io/terminal').destroySession(id); } catch (_) {}
      }
      // A disposed `agent` instance owns a live backend session keyed the
      // same way (session id == instance id) — tear it down + forget it.
      // Straggler events, incl. the backend's own final exit, drop via
      // io/agent's stale-session guard.
      if (kind === 'agent') {
        try { require('../io/agent').destroy(id); } catch (_) {}
      }
      route.disposeInstance(id);
    }
  }
}

function initState() {
  const m = getModel();
  const config = m.config;
  // Theme is model state (model.theme) — seed it through the reducer like the
  // other boot Msgs below, not by poking the palette cache. The `set_theme`
  // effect (registered by installBuiltins, which runs before initState in both
  // tui.js#main and the test harness) syncs leaves/infra/themes from model.theme.
  // This is the init→Cmd shape: initial model carries the theme, an initial
  // Msg applies the configured one.
  require('../dispatch/control/dispatch').applyMsg({ type: 'set_theme', name: config.theme || 'default' });

  // Force-register the layout / groups Components — production (tui.js) already
  // did, but the test harness path may have skipped them.
  _layoutSlice();
  _groupsSlice();

  // Seed the layout arrange struct from config via the layout
  // Component's own writer (set_arrange Msg). Single-writer holds at
  // boot too — initState doesn't poke at slice fields directly. All
  // other slice/model state initializes from runtime.init() /
  // Component.init() defaults; only config-derived seeds (arrange,
  // currentGroup, register cap) and the theme set need a write here.
  const api = require('../panel/api');
  require('../dispatch/runtime/loop').dispatchMsg(api.wrap('layout', {
    type: 'set_arrange',
    arrange: rebuildLayoutFromConfig(config),
    dirty: false,
  }));

  // v0.6.3 Phase B / v0.6.4 multi-viewer — per-pane Component instances keyed
  // by paneId (every placed pane its own slice). The mint/dispose logic lives
  // in reconcilePaneInstances so the dispatch finalizer can re-run it after
  // runtime placement/removal. Wire the injection BEFORE seeding dims: the
  // term_resized dispatch below runs the finalizer with arrange + dims both
  // set, so the boot mint happens THROUGH the gate (which records
  // _lastReconciledArrange) — one unified reconcile path, no separate direct
  // boot call that would leave the gate's bookkeeping stale (→ a redundant
  // re-mint on the first post-boot dispatch).
  require('../dispatch/runtime/finalize').setInstanceReconciler(reconcilePaneInstances);
  // #D13 — hub subscriptions reconcile each outermost dispatch (canonical
  // Model → Sub). Wired BEFORE the term_resized dispatch below, so its finalizer
  // performs the boot sub-wiring through the same path as the boot instance mint.
  require('../dispatch/runtime/finalize').setSubscriptionReconciler(reconcileSubscriptions);

  // Seed the model's terminal dimensions (resize-as-Msg P1). The ONLY
  // place besides the tui.js 'resize' listener that reads the live
  // terminal size — everything downstream reads layoutSlice.dims. This
  // dispatch's finalizer also performs the boot instance mint (see above).
  const tdims = require('../io/term').dims();
  require('../dispatch/runtime/loop').dispatchMsg(api.wrap('layout', {
    type: 'term_resized', cols: tdims.cols, rows: tdims.rows,
  }));

  // Rebuild the visible group list from config, then seed currentGroup
  // from the first visible row. recomputeGroups dispatches into the
  // groups Component; set_current_group rides through the root reducer.
  navState.recomputeGroups();
  const groupsAfter = _groupsSlice();
  const firstName = groupsAfter.list.length ? groupsAfter.list[0].name : '';
  require('../dispatch/control/dispatch').applyMsg({ type: 'set_current_group', name: firstName });

  // Yank register — bounded history, system-clipboard mirror. Cap is
  // configurable via top-level `register: { cap: N }` in YAML; default
  // 100. Init deferred to here so cap reflects the parsed config.
  // v0.6.3 Phase D3 — routed through set_register Msg so the reducer
  // is the sole writer to root.register. Was a BLESSED outside-writer.
  require('../dispatch/control/dispatch').applyMsg({
    type: 'set_register',
    register: require('../leaves/register').init(config.register || {}),
  });

  // Soft-fail diagnostics from parse (today: column over soft cap).
  // Records one event-log entry per warning + seeds layout's bootWarnings
  // so the footer paints "⚠ N config warning(s)" until dismissed.
  const warnings = Array.isArray(config.warnings) ? config.warnings : [];
  if (warnings.length > 0) {
    const log = require('../io/event-log');
    const diag = require('../io/diag-log');
    for (const w of warnings) {
      log.record('warning', { code: w.code, message: w.message });
      diag.warn(w.code || 'config', w.message);
    }
    require('../dispatch/runtime/loop').dispatchMsg(api.wrap('layout', {
      type: 'set_boot_warnings',
      warnings: warnings.map(w => w.message),
    }));
  }
}


/**
 * Reset the per-group transient UI state. Called when the user navigates
 * to a different group — selections in group-scoped panels go back to
 * row 0, the detail tab returns to "Info", filters/last-action/terminal
 * mode are cleared. Routes through reset_group_context (root reducer) +
 * viewer_reset_chrome (detail Component).
 */
function resetGroupContext() {
  // Two writes: the root-chrome reset is a Msg into runtime.update; the
  // viewer-slice half is its own Msg dispatched to the resolved viewer
  // target. resolveTarget returns null when no viewer is registered —
  // the viewer-half Cmd drops in that case.
  const dispatch = require('../dispatch/control/dispatch');
  const api = require('../panel/api');
  const route = require('../panel/route');
  // #D9 — resolve the per-panel owners here (impure shell) so the reducer's
  // reset_group_context arm stays pure of the ownership registry.
  dispatch.applyMsg({ type: 'reset_group_context', owners: route.resetGroupOwners() });
  const target = route.resolveTarget('viewer');
  if (target) {
    // v0.6.3 Phase D1: thread paneMenuMode so the reducer stays pure.
    const m = getModel();
    const loop = require('../dispatch/runtime/loop');
    loop.dispatchMsg(api.wrap(target, { type: 'viewer_reset_chrome', paneMenuMode: !!m.modes.paneMenuMode }));
    // U2e P1b — the menu-close half of the reset is a mode/layout concern, hoisted
    // out of the (now content-instance) target arm. Idempotent (closes an already-
    // closed menu as a no-op). Was emitted by the detail viewer_reset_chrome arm.
    if (m.modes.paneMenuMode) loop.dispatchMsg(api.wrap('layout', { type: 'pane_menu_close' }));
  }
}

/**
 * Set the active group by its index in the visible group list. No-op on
 * out-of-range. Resets per-group transient state via resetGroupContext().
 */
function selectGroup(idx) {
  // dispatch.navSelect does the per-Component routing (set_cursor →
  // owning Component + show_selected_info + the groups_selected
  // cascade).
  require('../dispatch/control/dispatch').navSelect('groups', idx);
}


module.exports = {
  // Boot layer + dispatch-layer group helpers, defined here.
  loadConfig, initState, selectGroup, resetGroupContext,
  // #D13 — exposed for tests: the Model→Sub reconciler, its pure desired-set
  // projection, the per-descriptor add/merge, and the live-set teardown/reset.
  reconcileSubscriptions, _desiredSubs, _addDesired, _resetSubscriptions,
  // Test-only: the live subscription keys — lets a test assert the gated
  // `clock` sub actually arms/tears down as a stream job starts/ends (the
  // reconcile-gate coverage for the live action-status line).
  _liveSubKeys: () => [..._liveSubs.keys()],
  // Production quit-teardown: stop every live Sub (kill process-stream
  // children, cancel intervals, remove the resize listener). Same impl as the
  // test reset; wired to process exit from tui.js (FIX-3 Phase 5).
  teardownSubscriptions: _resetSubscriptions,
  // The per-pane instance reconciler — wired to the dispatch finalizer at boot
  // (initState) AND by the replay harness (app/replay-cli) so a replayed
  // set_arrange mints the same per-pane slices. Exported for that second caller.
  reconcilePaneInstances,
  // Panel-state accessors — re-exported from panel/nav-state for back-compat
  // (§1 Phase 2). New code should import these from panel/nav-state.
  allPanels: navState.allPanels,
  getSel: navState.getSel, setSel: navState.setSel,
  getScroll: navState.getScroll, setScroll: navState.setScroll,
  syncPanelScroll: navState.syncPanelScroll,
  toggleMultiSel: navState.toggleMultiSel, isMultiSel: navState.isMultiSel,
  clearMultiSel: navState.clearMultiSel, multiSelCount: navState.multiSelCount,
  expandGroup: navState.expandGroup, collapseGroup: navState.collapseGroup,
  recomputeGroups: navState.recomputeGroups, switchGroupsTab: navState.switchGroupsTab,
  setViewerContent: navState.setViewerContent, appendViewerLines: navState.appendViewerLines,
};

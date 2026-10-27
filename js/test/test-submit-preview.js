/**
 * Brief 3 (v0.6.44) — submit preview + `sensitive:` port opt.
 *
 * Covers every surface the preview + sensitive feature needs to agree
 * on so a sensitive port can't leak through one path while the others
 * mask it:
 *
 *   - Parser (`js/parser/schema.js`): `sensitive: true` strict-boolean
 *     parse (warn-drop non-bool as `port.bad_sensitive`); IMPLICIT
 *     coupling with `remember: false` (sensitive overrides a declared
 *     remember:true with a warning); the stamped remember:false value
 *     survives through to the normalized port decl.
 *   - Pure leaf (`js/leaves/ports/submit-preview.js`):
 *     - `formatPreview`: lays out the script + per-port lines + the
 *       variadic argv tail; sensitive ports render as `name=••••••`
 *       regardless of resolution state (resolved / pending / defaulted);
 *       non-sensitive pending ports render as `name=<pending>` with no
 *       source tag.
 *     - `formatCompactFooter`: one-line summary with port count +
 *       sensitive count + a truncated script teaser; sensitive count
 *       flagged with the `[warning]` theme slot.
 *   - Confirm overlay (`js/overlay/confirm.js`): paints the preview
 *     block below the confirm message when the staged `do_run` cmd's
 *     action has declared `ports.in`; absent when it doesn't.
 *   - Form overlay (`js/overlay/fabric-form.js`): the compact footer
 *     reflects LIVE field.text (not just defaults — the user may be
 *     mid-edit), masks sensitive ports in the sensitive-count tally.
 *   - WAL discipline: the formatted preview text is NEVER stamped into
 *     a Msg payload (the brief's rule). The leaf is called from
 *     render functions, not from reducer arms — pinned by inspection.
 *
 * Run: node js/test/test-submit-preview.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const runtime = require('../app/runtime');
const store = require('../model/store');
const { getModel } = store;
// v0.6.46 — [4] inject-reading tests + [7] end-to-end tests resolve ports
// through `leaves/ports/resolve-for-render`, which calls fabricPorts.listWires().
// Wire the fabric host once at module load so `h()` doesn't throw.
require('../dispatch/runtime/host-wiring').wireFabricHost();
const {
  formatPreview, formatCompactFooter, SENSITIVE_MASK,
} = require('../leaves/ports/submit-preview');
const { freshOverlayModel, captureOverlay } = require('./_helpers/overlay-capture');
const { renderConfirmOverlay } = require('../overlay/confirm');
const { renderFabricFormOverlay } = require('../overlay/fabric-form');
// Parser direct entry — mutates `data` in place, stamps normalized fields,
// pushes warnings to the array. Same shape test-parser-schema.js uses.
const { validate: parserValidate } = require('../parser/schema');

// ---- [1] pure leaf: formatPreview --------------------------------------

describe('[1] formatPreview — script + per-port + variadic', () => {
  it('empty inputs yield an empty array', () => {
    eq(formatPreview({}).length, 0, 'no script, no ports, no variadic → no lines');
  });
  it('script-only renders a $-prefixed shell line', () => {
    const lines = formatPreview({ script: 'echo hello' });
    eq(lines.length, 1, 'one line');
    assert(lines[0].includes('echo hello'), 'script present');
    assert(lines[0].includes('$'), '$-prefix present');
  });
  it('a non-sensitive port with a resolved value shows source tag', () => {
    const lines = formatPreview({
      script: 'deploy $env',
      boundPorts: [{ name: 'env', decl: { type: 'string' }, value: 'prod', source: 'user' }],
    });
    assert(lines.find(l => l.includes('env=prod')), 'name=value present');
    assert(lines.find(l => l.includes('[user]')), 'source tag present');
  });
  it('a non-sensitive port with no value shows <pending>', () => {
    const lines = formatPreview({
      boundPorts: [{ name: 'env', decl: { type: 'string' }, value: null, source: null }],
    });
    assert(lines.find(l => l.includes('env=<pending>')), '<pending> marker');
    // No source tag when value is pending.
    assert(!lines.some(l => l.includes('[default]') || l.includes('[user]')),
      'no source tag on pending row');
  });
  it('a sensitive port masks the value with ••••••', () => {
    const lines = formatPreview({
      boundPorts: [{
        name: 'passphrase',
        decl: { type: 'string', sensitive: true },
        value: 'hunter2',
        source: 'user',
      }],
    });
    assert(lines.find(l => l.includes(`passphrase=${SENSITIVE_MASK}`)),
      `name=${SENSITIVE_MASK} present`);
    assert(!lines.some(l => l.includes('hunter2')), 'raw value absent');
  });
  it('a sensitive port masks EVEN WHEN pending (no distinguishing <pending>)', () => {
    const lines = formatPreview({
      boundPorts: [{
        name: 'passphrase',
        decl: { type: 'string', sensitive: true },
        value: null, source: null,
      }],
    });
    assert(lines.find(l => l.includes(`passphrase=${SENSITIVE_MASK}`)),
      'mask applied even for pending sensitive port');
    assert(!lines.some(l => l.includes('<pending>')),
      '<pending> marker suppressed for sensitive to avoid leaking fill state');
  });
  it('variadic rendering — list of items with trailing dash prefix', () => {
    const lines = formatPreview({
      script: 'tar czf archive.tar.gz $@',
      variadic: {
        name: 'paths',
        decl: { type: 'string', variadic: true },
        items: ['a.txt', 'b.txt', 'c.txt'],
      },
    });
    assert(lines.find(l => l.includes('paths:')), 'variadic label row');
    assert(lines.find(l => l.includes('a.txt')), 'first item');
    assert(lines.find(l => l.includes('b.txt')), 'second item');
    assert(lines.find(l => l.includes('c.txt')), 'third item');
  });
  it('variadic + sensitive renders as masked count, no items leaked', () => {
    const lines = formatPreview({
      variadic: {
        name: 'secrets',
        decl: { type: 'string', variadic: true, sensitive: true },
        items: ['s1', 's2', 's3'],
      },
    });
    assert(lines.find(l => l.includes(`secrets=${SENSITIVE_MASK}`)),
      `secrets=${SENSITIVE_MASK} summary`);
    assert(!lines.some(l => l.includes('s1')), 'first item hidden');
    assert(!lines.some(l => l.includes('s2')), 'second item hidden');
    assert(lines.find(l => l.includes('3 items')), 'item count disclosed');
  });
  it('empty variadic items array is skipped (not rendered)', () => {
    const lines = formatPreview({
      script: 'ls $@',
      variadic: { name: 'paths', decl: {}, items: [] },
    });
    // Script line only; no variadic rows.
    eq(lines.length, 1, 'script only');
  });
});

// ---- [2] pure leaf: formatCompactFooter --------------------------------

describe('[2] formatCompactFooter — one-line summary', () => {
  it('zero ports and no script → "0 ports"', () => {
    const line = formatCompactFooter({});
    assert(line.includes('0 ports'), 'count rendered');
  });
  it('N ports with no sensitive → "N ports"', () => {
    const line = formatCompactFooter({
      script: 'echo',
      boundPorts: [{ name: 'a', decl: {} }, { name: 'b', decl: {} }],
    });
    assert(line.includes('2 ports'), 'count');
    assert(!line.includes('sensitive'), 'no sensitive tag');
  });
  it('K sensitive is flagged with [warning] theme', () => {
    const line = formatCompactFooter({
      boundPorts: [
        { name: 'env', decl: {} },
        { name: 'pass', decl: { sensitive: true } },
        { name: 'token', decl: { sensitive: true } },
      ],
    });
    assert(line.includes('2 sensitive'), 'sensitive count');
    assert(line.includes('[warning]'), '[warning] theme slot');
  });
  it('long script teaser truncates with ellipsis', () => {
    const longScript = 'echo ' + 'x'.repeat(80);
    const line = formatCompactFooter({ script: longScript });
    assert(line.includes('…'), 'ellipsis present');
    assert(line.length < longScript.length + 50, 'line is shorter than full script');
  });
  it('singular port tag is "port" not "ports"', () => {
    const line = formatCompactFooter({ boundPorts: [{ name: 'a', decl: {} }] });
    assert(line.includes('1 port'), 'count rendered');
    assert(!/1 ports/.test(line), 'singular — no trailing s');
  });
});

// ---- [3] parser: sensitive strict-boolean + implicit coupling ---------

describe('[3] parser — sensitive strict-boolean + implicit remember:false', () => {
  // Direct parser entry: validate(data, source, warnings) mutates `data`
  // in place and pushes to the warnings array.
  function parsePort(portDecl) {
    const data = {
      project_dir: '.',
      groups: {
        g: {
          label: 'G', containers: [],
          actions: {
            a: {
              type: 'run',
              script: 'echo $x',
              label: 'A',
              ports: { in: { x: { type: 'string', ...portDecl } } },
            },
          },
        },
      },
    };
    const warnings = [];
    try {
      parserValidate(data, '/tmp/t.yml', warnings);
      return { data, warnings, error: null };
    } catch (e) {
      return { data: null, warnings, error: e };
    }
  }
  function portOf(r) {
    return r.data && r.data.groups && r.data.groups.g.actions.a.ports.in.x;
  }

  it('sensitive:true is accepted; strict-boolean parse succeeds', () => {
    const r = parsePort({ sensitive: true });
    assert(!r.error, 'no parse error');
    const port = portOf(r);
    assert(port, 'port parsed');
    eq(port.sensitive, true, 'sensitive stamped true');
    assert(!r.warnings.find(w => w.code === 'port.bad_sensitive'), 'no bad_sensitive warning');
  });
  it('sensitive:"yes" (string) is warn-dropped as port.bad_sensitive', () => {
    const r = parsePort({ sensitive: 'yes' });
    assert(!r.error, 'warn-drop does not throw');
    const port = portOf(r);
    eq(port.sensitive, undefined, 'sensitive dropped');
    const w = r.warnings.find(w => w.code === 'port.bad_sensitive');
    assert(w, 'bad_sensitive warning emitted');
    assert(w.message.includes('got string'), 'warning names the bad type');
  });
  it('sensitive:null is warn-dropped as "got null" (not "got object")', () => {
    const r = parsePort({ sensitive: null });
    const w = r.warnings.find(w => w.code === 'port.bad_sensitive');
    assert(w, 'bad_sensitive warning emitted');
    assert(w.message.includes('got null'), 'warning says "got null"');
  });
  it('sensitive:true implicitly stamps remember:false', () => {
    const r = parsePort({ sensitive: true });
    eq(portOf(r).remember, false, 'remember forced to false');
  });
  it('sensitive:true + remember:true → warning, remember forced false', () => {
    const r = parsePort({ sensitive: true, remember: true });
    eq(portOf(r).remember, false, 'remember overridden to false by sensitive');
    const w = r.warnings.find(w => w.code === 'port.sensitive_overrides_remember');
    assert(w, 'override warning emitted');
  });
  it('sensitive:true + remember:false → no warning (consistent decl)', () => {
    const r = parsePort({ sensitive: true, remember: false });
    assert(!r.warnings.find(w => w.code === 'port.sensitive_overrides_remember'),
      'no override warning when remember was already false');
  });
  it('sensitive:false (explicit) is accepted; no implicit remember override', () => {
    const r = parsePort({ sensitive: false, remember: true });
    const port = portOf(r);
    eq(port.sensitive, false, 'sensitive:false stamped');
    eq(port.remember, true, 'remember untouched');
  });
});

// ---- [4] confirm overlay — preview block appears for do_run on ports.in --

describe('[4] confirm overlay — preview block visibility', () => {
  function openConfirmWithStagedDoRun(action, actionKey) {
    const m = freshOverlayModel({ cols: 120, rows: 30 });
    m.currentGroup = 'g';
    // v0.6.46 — runAction stamps `group` on the cmd so the overlay reads
    // injects from the staged group (not model.currentGroup). Match the
    // real shape so these tests exercise the actual production path.
    const [m2] = runtime.update(m, {
      type: 'confirm_enter',
      message: 'Are you sure?',
      cmd: { type: 'do_run', actionKey, action, args: [], group: 'g' },
    });
    store.setModel(m2);
    return m2;
  }
  it('action WITHOUT ports.in → no preview block painted', () => {
    const m = openConfirmWithStagedDoRun(
      { type: 'run', script: 'echo hi' }, 'simple');
    const out = captureOverlay(m, () => renderConfirmOverlay());
    assert(out.includes('Are you sure?'), 'message painted');
    assert(!out.includes('preview'), 'no preview block without ports.in');
    assert(out.includes('[y] confirm'), 'y/n hint painted');
  });
  it('action WITH ports.in → preview block paints script + port rows', () => {
    const action = {
      type: 'run', script: 'deploy --env $env',
      ports: { in: {
        env: { type: 'string', default: 'staging' },
      } },
    };
    const m = openConfirmWithStagedDoRun(action, 'deploy');
    const out = captureOverlay(m, () => renderConfirmOverlay());
    assert(out.includes('preview'), 'preview marker painted');
    assert(out.includes('deploy --env $env'), 'script line painted');
    assert(out.includes('env=staging'), 'port value painted (from default)');
  });
  it('sensitive port in the preview block renders as ••••••', () => {
    const action = {
      type: 'run', script: 'rotate-ca $passphrase',
      ports: { in: {
        passphrase: { type: 'string', sensitive: true, required: true },
      } },
    };
    const m = openConfirmWithStagedDoRun(action, 'rotate-ca');
    const out = captureOverlay(m, () => renderConfirmOverlay());
    assert(out.includes(`passphrase=${SENSITIVE_MASK}`),
      `passphrase=${SENSITIVE_MASK} rendered`);
    assert(!out.includes('<pending>'), '<pending> suppressed for sensitive');
  });
  it('mixed sensitive + non-sensitive ports render independently', () => {
    const action = {
      type: 'run', script: 'deploy --env $env --token $token',
      ports: { in: {
        env:   { type: 'string', default: 'prod' },
        token: { type: 'string', sensitive: true, required: true },
      } },
    };
    const m = openConfirmWithStagedDoRun(action, 'deploy');
    const out = captureOverlay(m, () => renderConfirmOverlay());
    assert(out.includes('env=prod'), 'non-sensitive shows value');
    assert(out.includes(`token=${SENSITIVE_MASK}`), 'sensitive masked');
  });
  it('sensitive port with an in-flight INJECT still masks (round-2 coverage gap)', () => {
    // Pre-release round-2 test-coverage review: the sensitive-port
    // tests above exercised DEFAULT and PENDING paths but not the
    // INJECT path. If a sensitive port had a sticky inject (from a
    // prior ports-pane edit or an `[a]` edit-args that staged
    // values), the confirm overlay reads it from model.fabric.injects
    // — and MUST mask it.
    const action = {
      type: 'run', script: 'rotate-ca --pass $passphrase',
      ports: { in: {
        passphrase: { type: 'string', sensitive: true, required: true, remember: false },
      } },
    };
    const m = openConfirmWithStagedDoRun(action, 'rotate-ca');
    // v0.6.46 — injects are GROUP-KEYED (`{[group]: {[addr]: {value,
    // at, oneShot?}}}`), not flat `{[addr]: value}`. Pre-fix, this test
    // (and the broken overlay reader) both used the wrong shape and the
    // test still "passed" because the sensitive mask fires before any
    // value lookup. Writing the correct shape now EXERCISES the inject-
    // read path end-to-end — the mask must still fire, AND the raw
    // value must never appear.
    m.fabric = { injects: { g: { 'rotate-ca.passphrase':
      { value: 'hunter2-raw-leaked', at: 0, oneShot: true } } } };
    store.setModel(m);
    const out = captureOverlay(m, () => renderConfirmOverlay());
    assert(out.includes(`passphrase=${SENSITIVE_MASK}`), 'sensitive mask applied');
    assert(!out.includes('hunter2-raw-leaked'),
      'raw inject value NEVER appears in the preview output');
  });
  it('action with EMPTY ports.in: {} does NOT paint `-- preview --` separator', () => {
    // Pre-release round-2 edge-case: {} is truthy but empty.
    // The confirm should treat it the same as no ports.in at all.
    const action = { type: 'run', script: 'echo hi', ports: { in: {} } };
    const m = openConfirmWithStagedDoRun(action, 'empty-ports');
    const out = captureOverlay(m, () => renderConfirmOverlay());
    assert(!out.includes('── preview ──'), 'no preview separator for empty ports.in');
    assert(out.includes('[y] confirm'), 'confirm still functional');
  });
});

// ---- [4b] security: markup injection via wire-fed values (round-2 BUG) ----

describe('[4b] security — markup injection in preview surfaces is blocked', () => {
  it('a wire-fed port value with rich-markup is esc()d, not interpreted', () => {
    const lines = formatPreview({
      boundPorts: [{
        name: 'env',
        decl: { type: 'string' },
        value: '[reverse]SAFE[/]',  // wire-fed attempt to spoof the display
        source: 'wire',
      }],
    });
    const joined = lines.join('\n');
    // The literal brackets must be present as ESCAPED text, not as markup
    // that would render SAFE as reverse-video. esc() turns `[` into `\[`
    // (or similar), which rich-to-ansi then paints as a literal `[`.
    assert(joined.includes('env='), 'port name rendered');
    assert(joined.includes('SAFE'), 'raw text letters still visible');
    // The matcher is: `[reverse]` as RAW (literal brackets) must not
    // appear unescaped (which would open the reverse-video style). esc()
    // outputs `\[reverse\]` or similar; we assert the escaped form is
    // present by checking the preceding backslash marker or that the
    // literal `[reverse]` substring is NOT paired with a closing `[/]`
    // bracket that would open+close.
    assert(/\\\[reverse\\\]/.test(joined) || !/\[reverse\][^\\]*\[\/\]/.test(joined),
      'markup kept literal (either as \\[ escaped or as content without a matching [/] closer)');
  });
  it('a wire-fed VARIADIC item with rich-markup is esc()d too', () => {
    const lines = formatPreview({
      variadic: {
        name: 'paths',
        decl: { type: 'string', variadic: true },
        items: ['[dim]hidden[/]', 'normal.txt'],
      },
    });
    const joined = lines.join('\n');
    assert(joined.includes('normal.txt'), 'normal item visible');
    assert(joined.includes('hidden'), 'malicious item text still visible');
    // The dim markup must be escaped — same discipline.
    assert(/\\\[dim\\\]/.test(joined) || !/\[dim\]hidden\[\/\]/.test(joined),
      'variadic item markup kept literal');
  });
  it('script with injected markup is esc()d (both preview surfaces)', () => {
    const previewLines = formatPreview({ script: '[reverse]evil[/]' });
    const footer = formatCompactFooter({ script: '[reverse]evil[/]' });
    const previewJoined = previewLines.join('\n');
    assert(/\\\[reverse\\\]/.test(previewJoined) || !/\[reverse\]evil\[\/\]/.test(previewJoined),
      'preview script markup escaped');
    assert(/\\\[reverse\\\]/.test(footer) || !/\[reverse\]evil\[\/\]/.test(footer),
      'footer script markup escaped');
  });
  it('port NAME with (impossible) markup is esc()d defensively', () => {
    // isValidFabricName restricts port names, but one-rule-everywhere.
    const lines = formatPreview({
      boundPorts: [{ name: 'ok[dim]evil', decl: {}, value: 'v', source: null }],
    });
    const joined = lines.join('\n');
    assert(joined.includes('ok'), 'name letters visible');
  });
});

// ---- [5] form overlay — compact footer paints + masks sensitive -------

describe('[5] form overlay — compact footer with sensitive mask', () => {
  const ACTION_SENSITIVE = {
    label: 'Rotate CA', type: 'run', script: 'rotate-ca --pass $passphrase --env $env',
    ports: { in: {
      env:        { type: 'string', default: 'staging' },
      passphrase: { type: 'string', required: true, sensitive: true, remember: false },
    } },
  };
  function openForm(fields) {
    const m = freshOverlayModel({ cols: 120, rows: 30 });
    m.currentGroup = 'g';
    const [m2] = runtime.update(m, {
      type: 'fabric_form_enter',
      fields,
      pendingAction: { actionKey: 'rotate-ca', action: ACTION_SENSITIVE },
    });
    store.setModel(m2);
    return m2;
  }
  it('footer shows port count + script teaser', () => {
    const m = openForm([
      { port: 'env',        text: 'staging',  required: false, default: 'staging' },
      { port: 'passphrase', text: '',         required: true,  default: null, remember: false },
    ]);
    const out = captureOverlay(m, () => renderFabricFormOverlay());
    assert(out.includes('2 ports'), 'count rendered');
    assert(out.includes('rotate-ca'), 'script teaser visible');
  });
  it('footer flags sensitive count — the summary never carries port values', () => {
    // Build the footer DIRECTLY via the leaf (what the form overlay
    // invokes). The leaf-level assertion is the structural one: the
    // compact footer takes only `script` + `boundPorts[].name/decl` (no
    // value in the summary beyond count), so a port VALUE can't ride
    // the summary even if the user typed one. The field-renderer side
    // of the form may paint typed text (that's a separate UX decision
    // — v0.6.44 scope is preview + WAL masking, not field display).
    const line = formatCompactFooter({
      script: 'rotate-ca --pass $passphrase --env $env',
      boundPorts: [
        { name: 'env',        decl: { type: 'string', default: 'staging' } },
        { name: 'passphrase', decl: { type: 'string', sensitive: true, required: true, remember: false } },
      ],
    });
    assert(line.includes('1 sensitive'), 'sensitive count rendered');
    assert(!line.includes('hunter2'), 'no raw value in the summary (by construction — the leaf takes no value)');
    assert(line.includes('rotate-ca'), 'script teaser visible');
  });
  it('footer appears when the form is opened (overlay-level integration)', () => {
    const m = openForm([
      { port: 'env',        text: 'prod',     required: false, default: 'staging' },
      { port: 'passphrase', text: '',         required: true,  default: null, remember: false },
    ]);
    const out = captureOverlay(m, () => renderFabricFormOverlay());
    assert(out.includes('2 ports'), 'count in overlay');
    assert(out.includes('1 sensitive'), 'sensitive count in overlay');
  });
});

// ---- [5c] call-site discipline — fabric-form footer caller carries no value ----

describe('[5c] fabric-form.js footer call site passes NO value: field (anti-regression)', () => {
  it('grep the call site to ensure no future caller reintroduces a value: field', () => {
    // Pre-release round-2 test-coverage: the T1 round-1 fix dropped
    // the dead `value: field.text` carry from the fabric-form footer
    // caller. Pin that it stays dropped — a future refactor adding
    // `value:` back would quietly re-enable a secret-leak path if the
    // leaf's signature ever extended to use it.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../overlay/fabric-form.js'), 'utf8');
    const idx = src.indexOf('formatCompactFooter');
    assert(idx >= 0, 'formatCompactFooter call site found');
    // Scan a 500-char window around the call for a `value:` field in
    // the boundPorts constructor. The leaf-level signature test (§5
    // above) ensures the leaf itself takes no value; this test ensures
    // the CALLER doesn't pass one either.
    const start = Math.max(0, src.lastIndexOf('for (const field of f.fields)', idx));
    const window = src.slice(start, idx + 500);
    assert(!/value:\s*field\.text/.test(window),
      'the fabric-form footer builder must NOT carry `value: field.text` into the leaf');
  });
});

// ---- [5d] parser warn-drops for round-2 safety fixes --------------------

describe('[5d] parser — sensitive on OUT port + sensitive+default warnings (round-2)', () => {
  const { validate: parserValidate } = require('../parser/schema');
  function parseWithOutPort(outPortDecl) {
    const data = {
      project_dir: '.',
      groups: {
        g: {
          label: 'G', containers: [],
          actions: {
            a: {
              type: 'run',
              label: 'A',
              run: 'cmd',
              ports: {
                in: { x: { type: 'string', required: true } },
                out: { y: { type: 'string', from: 'stdout', ...outPortDecl } },
              },
            },
          },
        },
      },
    };
    const warnings = [];
    try { parserValidate(data, '/tmp/t.yml', warnings); return { data, warnings, error: null }; }
    catch (e) { return { data: null, warnings, error: e }; }
  }
  it('sensitive on an OUTPUT port emits port.sensitive_on_out_port and drops the key', () => {
    const r = parseWithOutPort({ sensitive: true });
    assert(!r.error, 'warn-drop does not throw');
    const w = r.warnings.find(w => w.code === 'port.sensitive_on_out_port');
    assert(w, 'warning emitted');
    const outPort = r.data && r.data.groups && r.data.groups.g.actions.a.ports.out.y;
    assert(outPort, 'out port parsed');
    eq(outPort.sensitive, undefined, 'sensitive stripped from out port');
  });
  function parsePort(portDecl) {
    const data = {
      project_dir: '.',
      groups: {
        g: {
          label: 'G', containers: [],
          actions: {
            a: {
              type: 'run',
              label: 'A',
              script: 'echo $x',
              ports: { in: { x: { type: 'string', ...portDecl } } },
            },
          },
        },
      },
    };
    const warnings = [];
    try { parserValidate(data, '/tmp/t.yml', warnings); return { data, warnings }; }
    catch (e) { return { data: null, warnings, error: e }; }
  }
  it('sensitive:true + default:"devpass" emits port.sensitive_with_default', () => {
    const r = parsePort({ sensitive: true, default: 'devpass' });
    const w = r.warnings.find(w => w.code === 'port.sensitive_with_default');
    assert(w, 'warning emitted');
    // Default is NOT dropped — the warning is advisory; author may want
    // the eyes-open override behavior.
    const port = r.data.groups.g.actions.a.ports.in.x;
    eq(port.default, 'devpass', 'default preserved (warning is advisory)');
  });
  it('sensitive:true WITHOUT default: no warning (clean decl)', () => {
    const r = parsePort({ sensitive: true });
    assert(!r.warnings.find(w => w.code === 'port.sensitive_with_default'),
      'no spurious warning when there is no default');
  });
});

// ---- [6] WAL discipline — preview text never stamped into Msgs ---------

describe('[6] preview is formatted at render time, never carried by a Msg', () => {
  it('no reducer arm imports from submit-preview.js', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '../dispatch/update');
    const walk = (d) => {
      const out = [];
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) out.push(...walk(p));
        else if (e.name.endsWith('.js')) out.push(p);
      }
      return out;
    };
    for (const file of walk(dir)) {
      const src = fs.readFileSync(file, 'utf8');
      assert(!src.includes("require('../../leaves/ports/submit-preview')") &&
             !src.includes("require('../../../leaves/ports/submit-preview')"),
        `reducer file ${path.basename(file)} must not import submit-preview (format at render time)`);
    }
  });
});

// -------------------------------------------------------------------------
// [7] confirm preview — END-TO-END through the REAL submit → confirm pipeline.
//
// This section exists because v0.6.44's [4] tests above fed `formatPreview`
// hand-built `boundPorts` — which is how a group-key resolver bug shipped:
// the overlay's inline mini-resolver read `model.fabric.injects[addr]` at the
// top level, but injects live at `model.fabric.injects[group][addr].value`.
// Every port rendered `<pending>` on the real [a]-submit → confirm flow, even
// when the form had just collected a value. The leaf tests couldn't catch it
// because they bypassed the resolver entirely.
//
// The regression surface here is: start from a real action, drive
// `openPortsForm` + `fabric_form_submit` through the real applyMsg loop,
// then run `renderConfirmOverlay` and assert on the PAINTED text. Pins:
//   - A form-collected value shows resolved + [inject] tag, not <pending>
//   - Byte-equal to what the spawn's env binding will receive on accept
//   - Group stamp isolates: a mid-confirm group switch doesn't change
//     the preview (the overlay reads the stamped group, not currentGroup)
//   - Variadic port: items listed, not <pending> / not `[object Object]`
//   - Decline-rollback (v0.6.45 round-2): declined [a] → re-invoke shows
//     <pending> again (one-shots were consumed by confirm_reject)
// -------------------------------------------------------------------------

describe('[7] confirm preview — END-TO-END through real submit + staging', () => {
  const sm = require('./smoke/_helpers/smoke');
  const runner = require('../dispatch/runtime/action-runner');
  const { applyMsg } = require('../dispatch/control/dispatch');
  const { wireFabricHost } = require('../dispatch/runtime/host-wiring');
  wireFabricHost();

  const ROTATE_CA = {
    type: 'run',
    script: 'exec ./rotate-ca.sh "$force" ${passphrase:?required}',
    confirm: 'Really revoke the CA?',
    ports: { in: {
      force:      { type: 'string', required: true },
      passphrase: { type: 'string', required: true, sensitive: true, remember: false },
      server_cn:  { type: 'string', required: false },
    } },
  };

  function openFormFillSubmitStageConfirm(action, actionKey, fills) {
    // Open [a] → fill fields → submit (writes injects + stamps onReject +
    // emits run_action) → simulate the run_action effect's call into
    // runAction by directly dispatching confirm_enter the way runAction
    // would (preserves the staged group + cmd shape).
    sm.bootFresh();
    if (getModel().modal.onReject) getModel().modal.onReject = null;
    // bootFresh doesn't clear model.fabric.injects — a prior test's
    // one-shot injects would otherwise leak as pre-fill values on the
    // new form's field texts, and typing on top would concatenate.
    // Same hazard with formHistory (last-used precedence inside
    // _buildFormField reads `${group}.${actionKey}` across scenarios).
    const m0 = getModel();
    if (m0.fabric) m0.fabric.injects = {};
    m0.formHistory = { entries: {}, order: [], cap: 64 };
    const resolved = runner._resolvePortsForAction(actionKey, action, getModel());
    runner.openPortsForm(actionKey, action, resolved, { confirmed: false });
    for (const [port, text] of Object.entries(fills)) {
      // Focus the field, then type.
      let f = getModel().modal.fabricForm;
      let idx = f.fields.findIndex((x) => x.port === port);
      while (f.focusIdx !== idx) {
        applyMsg({ type: 'fabric_form_focus_next' });
        f = getModel().modal.fabricForm;
      }
      for (const c of text) applyMsg({ type: 'fabric_form_key', key: c, seq: c });
    }
    applyMsg({ type: 'fabric_form_submit' });
    // Simulate what runAction does on seeing action.confirm: stage confirm_enter
    // with cmd={type:'do_run', actionKey, action, args, group:currentGroup}.
    const group = getModel().currentGroup || '';
    applyMsg({
      type: 'confirm_enter',
      message: action.confirm || 'Are you sure?',
      cmd: { type: 'do_run', actionKey, action, args: [], group },
    });
    return getModel();
  }

  it('REGRESSION — form-collected value appears RESOLVED in the preview, not <pending>', () => {
    const m = openFormFillSubmitStageConfirm(ROTATE_CA, 'rotate-ca',
      { force: '--refused', server_cn: 'ca.example.org' });
    const out = captureOverlay(m, () => renderConfirmOverlay());
    assert(out.includes('force=--refused'),
      `BUG regression: force must show resolved value, not <pending>. Got overlay:\n${out}`);
    assert(out.includes('server_cn=ca.example.org'),
      `server_cn must show resolved value, not <pending>. Got overlay:\n${out}`);
    assert(!out.includes('force=<pending>'),
      `force must NOT be <pending> after a form submit wrote the inject`);
    assert(!out.includes('server_cn=<pending>'),
      `server_cn must NOT be <pending> after a form submit wrote the inject`);
    // Sensitive stays masked regardless of fill state.
    assert(out.includes(`passphrase=${SENSITIVE_MASK}`),
      `passphrase sensitive mask still applied`);
  });

  it('BYTE-EQUALITY — the preview value matches what the spawn would env-bind', () => {
    const m = openFormFillSubmitStageConfirm(ROTATE_CA, 'rotate-ca',
      { force: '--refused' });
    // Resolve exactly the way the spawn's doRun path does, in the STAGED
    // group (not model.currentGroup, which is where it currently sits
    // anyway — the invariant is "same group as the staged confirm").
    const spawnResolved = runner._resolvePortsForAction('rotate-ca', ROTATE_CA, m);
    eq(spawnResolved.values.force, '--refused',
      `spawn-side resolver finds the inject`);
    const out = captureOverlay(m, () => renderConfirmOverlay());
    // The preview text contains `force=--refused` iff the preview reader
    // found the SAME value the spawn would. Byte-equality by substring
    // (the preview's row shape `  force=--refused  [inject]` is one line).
    assert(out.includes('force=--refused'),
      `preview value must byte-equal the spawn's env binding`);
  });

  it('GROUP STAMP — a mid-confirm group switch does NOT change the preview', () => {
    const m = openFormFillSubmitStageConfirm(ROTATE_CA, 'rotate-ca',
      { force: '--refused' });
    // Simulate the user navigating to a different group mid-confirm.
    const m2 = { ...m, currentGroup: 'completely-other-group' };
    store.setModel(m2);
    const out = captureOverlay(m2, () => renderConfirmOverlay());
    assert(out.includes('force=--refused'),
      `preview must read the STAGED group (continuation.group='g'), ` +
      `not the live currentGroup='completely-other-group' which has no injects`);
  });

  it('VARIADIC — the preview lists items, not <pending> and not [object Object]', () => {
    const VARIADIC_ACTION = {
      type: 'run',
      script: 'exec ssh "$host" -- "$@"',
      confirm: 'Run on host?',
      ports: { in: {
        host: { type: 'string', required: true },
        cmd:  { type: 'cmdline', variadic: true, required: true },
      } },
    };
    const m = openFormFillSubmitStageConfirm(VARIADIC_ACTION, 'ssh',
      { host: 'h.example', cmd: 'ls -la /tmp' });
    const out = captureOverlay(m, () => renderConfirmOverlay());
    assert(out.includes('host=h.example'),
      `host scalar resolved`);
    assert(!out.includes('[object Object]'),
      `BUG regression: raw record object must never appear in the preview. Got:\n${out}`);
    // Variadic items appear as a labeled list — exact format comes from
    // formatPreview's variadic branch. Pin the three items are visible.
    assert(out.includes('ls') && out.includes('-la') && out.includes('/tmp'),
      `variadic items listed in preview, not <pending>. Got:\n${out}`);
  });

  it('DECLINE-ROLLBACK LAYER — after a declined [a] confirm, re-invoke shows <pending>', () => {
    // Fill + submit + confirm_enter + reject.
    openFormFillSubmitStageConfirm(ROTATE_CA, 'rotate-ca',
      { force: '--refused' });
    applyMsg({ type: 'confirm_reject' });
    // After reject the v0.6.45 round-2 rollback fires port_consume_oneshot
    // on the written addrs, so the injects should be gone.
    const g = getModel().currentGroup;
    const injects = (getModel().fabric && getModel().fabric.injects
                     && getModel().fabric.injects[g]) || {};
    assert(!injects['rotate-ca.force'],
      `precondition: round-2 rollback consumed the inject on reject`);
    // Now simulate re-invoke → confirm stage: no form, just stage the
    // confirm the invoke path would (runAction with action.confirm set
    // but no form opened).
    applyMsg({
      type: 'confirm_enter',
      message: ROTATE_CA.confirm,
      cmd: { type: 'do_run', actionKey: 'rotate-ca', action: ROTATE_CA, args: [], group: g },
    });
    const out = captureOverlay(getModel(), () => renderConfirmOverlay());
    assert(out.includes('force=<pending>'),
      `BUG: the rolled-back value must now show <pending> again on re-invoke. ` +
      `Pre-fix (round-1 of this fix) the preview wrongly showed the declined ` +
      `value. Got overlay:\n${out}`);
  });

  it('empty staged group falls through to <pending> (safe failure mode)', () => {
    // A future caller that forgets to stamp group on the cmd. The leaf
    // treats an empty-string group as "no injects known" and renders
    // <pending> — safer than reading currentGroup (which could leak a
    // different group's injects into the preview).
    sm.bootFresh();
    if (getModel().modal.onReject) getModel().modal.onReject = null;
    const action = {
      type: 'run', script: 'echo $env',
      confirm: 'ok?',
      ports: { in: { env: { type: 'string', required: true } } },
    };
    // Write an inject under group 'g'.
    const m0 = getModel();
    m0.fabric = m0.fabric || { injects: {}, output: {} };
    m0.fabric.injects = m0.fabric.injects || {};
    m0.fabric.injects.g = m0.fabric.injects.g || {};
    m0.fabric.injects.g['x.env'] = { value: 'leaked', at: 0, oneShot: true };
    store.setModel(m0);
    // Stage confirm WITHOUT a group field on the cmd (simulating a stale
    // or buggy caller).
    applyMsg({
      type: 'confirm_enter',
      message: 'ok?',
      cmd: { type: 'do_run', actionKey: 'x', action, args: [] },   // no group
    });
    const out = captureOverlay(getModel(), () => renderConfirmOverlay());
    assert(out.includes('env=<pending>'),
      `empty staged group must NOT leak another group's injects into the preview. ` +
      `Got overlay:\n${out}`);
    assert(!out.includes('env=leaked'),
      `leaked value from group 'g' must not appear`);
  });
});

report();

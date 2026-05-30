/**
 * Event log — ring buffer + capture from the four input sources
 * (key, mouse, refresh, publish, action). See PRINCIPLES.md §11 and
 * js/event-log.js.
 *
 * Run: node js/test/test-event-log.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, eq, assert, report } = require('./test-runner');
const log = require('../event-log');

describe('[1] basic ring buffer', () => {
  log.clear();
  log.setCap(log.DEFAULT_CAP);

  it('starts empty', () => {
    eq(log.size(), 0, 'size 0 on init');
    eq(log.snapshot().length, 0, 'snapshot empty');
  });

  it('records type + payload', () => {
    log.record('key', { key: 'down' });
    const evs = log.snapshot();
    eq(evs.length, 1, 'one event');
    eq(evs[0].type, 'key', 'type preserved');
    eq(evs[0].payload.key, 'down', 'payload preserved');
    assert(typeof evs[0].t === 'number', 'timestamp present');
  });

  it('preserves insertion order', () => {
    log.clear();
    log.record('key', { key: 'a' });
    log.record('key', { key: 'b' });
    log.record('key', { key: 'c' });
    eq(log.snapshot().map((e) => e.payload.key).join(''), 'abc',
       'order = a,b,c');
  });

  it('caps at the configured limit (ring behavior)', () => {
    log.clear();
    log.setCap(3);
    for (const k of ['a', 'b', 'c', 'd', 'e']) log.record('key', { key: k });
    eq(log.size(), 3, 'capped at 3');
    eq(log.snapshot().map((e) => e.payload.key).join(''), 'cde',
       'oldest dropped, newest kept');
    log.setCap(log.DEFAULT_CAP);
  });
});

describe('[2] enable / disable gate', () => {
  log.clear();

  it('disabled record is a silent no-op', () => {
    log.enable(false);
    log.record('key', { key: 'x' });
    eq(log.size(), 0, 'no event recorded');
    log.enable(true);
  });

  it('enabled by default', () => {
    log.enable(true);
    assert(log.isEnabled(), 'enabled() returns true');
    log.record('key', { key: 'y' });
    eq(log.size(), 1, 'recording resumed');
  });
});

describe('[3] live stream tails to file (LAZYTUI_LOG)', () => {
  it('attachStream writes one JSON line per record', () => {
    log.clear();
    const fp = path.join(os.tmpdir(), `lazytui-eventlog-stream-${Date.now()}.log`);
    log.attachStream(fp);
    log.record('key', { key: 'down' });
    log.record('refresh', null);
    // Allow the stream to flush — Node createWriteStream is buffered
    // but tiny writes flush synchronously.
    log.detachStream();
    const lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
    // 3 lines = 1 session-start header + 2 events
    eq(lines.length, 3, 'header + 2 events written');
    const hdr = JSON.parse(lines[0]);
    eq(hdr.type, 'session-start', 'first line is session-start header');
    eq(JSON.parse(lines[1]).type, 'key', 'second line is key event');
    eq(JSON.parse(lines[2]).type, 'refresh', 'third line is refresh event');
    fs.unlinkSync(fp);
  });

  it('detachStream stops further writes', () => {
    log.clear();
    const fp = path.join(os.tmpdir(), `lazytui-eventlog-stop-${Date.now()}.log`);
    log.attachStream(fp);
    log.record('key', { key: 'a' });
    log.detachStream();
    log.record('key', { key: 'b' });   // should not reach the file
    const lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
    eq(lines.length, 2, 'header + first event only');
    fs.unlinkSync(fp);
  });
});

describe('[4] save() round-trips through JSON', () => {
  log.clear();
  log.record('key',     { key: 'down' });
  log.record('refresh', null);
  log.record('publish', { topic: 'docker.stats', rowKey: 'pg', sample: { cpu: 1.2 } });

  it('save writes a parseable document', () => {
    const fp = path.join(os.tmpdir(), `lazytui-eventlog-test-${Date.now()}.json`);
    log.save(fp);
    const doc = JSON.parse(fs.readFileSync(fp, 'utf8'));
    eq(doc.count, 3, 'count matches');
    eq(doc.events.length, 3, 'all three events serialized');
    eq(doc.events[0].type, 'key', 'first event type preserved');
    eq(doc.events[2].payload.topic, 'docker.stats', 'nested payload preserved');
    assert(typeof doc.lazytui === 'string', 'version header present');
    fs.unlinkSync(fp);
  });
});

describe('[5] hooks fire from the wired sources', () => {
  // Wired sources (see commit message):
  //   - dispatch.handleKey       → 'key'
  //   - hub.publish              → 'publish'
  //   - plugins/api.refreshAll   → 'refresh'
  //   - actions.runAction        → 'action'

  it('hub.publish appends a "publish" event', () => {
    log.clear();
    const hub = require('../hub');
    // Need a subscriber so the publish actually retains; recording
    // happens regardless but exercising the real path is cleaner.
    hub.subscribe('test.topic', { window: 5 });
    hub.publish('test.topic', 'row1', { v: 7 });
    const evs = log.snapshot();
    eq(evs.length, 1, 'one event recorded');
    eq(evs[0].type, 'publish', 'type = publish');
    eq(evs[0].payload.topic, 'test.topic', 'topic captured');
    eq(evs[0].payload.rowKey, 'row1', 'rowKey captured');
    eq(evs[0].payload.sample.v, 7, 'sample captured');
  });

  it('plugins.refreshAll appends a "refresh" event', async () => {
    log.clear();
    const { refreshAll } = require('../components/api');
    await refreshAll({});
    const evs = log.snapshot();
    eq(evs.length, 1, 'one event recorded');
    eq(evs[0].type, 'refresh', 'type = refresh');
  });

  // Note: 'key' and 'action' hooks are exercised indirectly by
  // the existing dispatch + action test suites (test-onkey-dispatch,
  // test-cli, test-bulk-commands etc.) — re-asserting them here would
  // duplicate that coverage. The hooks themselves are one-liners that
  // can't fail without breaking those suites.
});

report();

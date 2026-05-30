# lazytui — Testing

Two test layers, each with a different purpose. Run them all from
the repo root.

| Layer | What it covers | Where | How to run |
|---|---|---|---|
| Unit | TUI runtime + parser: state, dispatch, plugins, hub, render helpers, YAML schema, resolver | `js/test/test-*.js` | `node js/scripts/run-tests.js -q` |
| Integration | Live TUI against a real Docker stack + event paths | `test/` (run.sh + stack.yml + test.yml) | `test/run.sh up` then `test/run.sh tui` |

The unit layer is CI-friendly and runs in seconds; integration is
hands-on (Docker required) and is for exercising panels / terminals /
event streaming against real containers.

## Unit tests

Each test file runs in its own Node process so module state (hub
subscribers, plugin registry, fake timers) can't leak between files.
The harness in `js/test/test-runner.js` provides
`describe / it / section / assert / eq / report`.

```
node js/scripts/run-tests.js               # run all
node js/scripts/run-tests.js hub           # filter by name substring
node js/scripts/run-tests.js -q            # quiet — only show failing files
```

Per-file isolation means imports, `require.cache` resets, and global
mocks are local to one file. The discovery runner spawns each
`test-*.js` as a child process; aggregation happens in `run-tests.js`.

**Parser tests** live alongside the runtime tests as `test-parser-*.js`:
`test-parser-errors.js` (error hierarchy), `test-parser-resolver.js`
(variable + helper expansion), `test-parser-schema.js` (YAML schema
validation), `test-parser-pipeline.js` (end-to-end `parse()`). YAML
fixtures under `js/test/fixtures/` are reused across the parser suite.

Add a new test by dropping a `test-<topic>.js` into `js/test/`. Imports
to TUI modules use `../<module>`; the harness import is `./test-runner`
(sibling).

## Integration / live stack

`test/` ships a synthetic Docker compose stack purpose-built to exercise
the TUI: a long-running healthy container, a flood of log output, an
exited container ready to be re-started, and (with `--profile chaos`) a
crashloop generator.

```
test/run.sh up               # base stack
test/run.sh up all           # base + chaos profile
test/run.sh ps               # check status
test/run.sh tui              # launch TUI against test.yml
test/run.sh tui --design     # any TUI flag forwards through
test/run.sh down             # tear everything down
```

Run docker commands from another shell to exercise event paths:

```
docker kill   tui-test-running
docker pause  tui-test-running && docker unpause tui-test-running
docker stop   tui-test-flood
docker start  tui-test-exited
```

This layer is not run in CI — it requires a Docker daemon and is for
verifying that real PTY / event-stream / decorator behavior matches
what the unit tests stub.

## Naming

- `js/scripts/run-tests.js` — discovery + sequencer (entry point you invoke).
- `js/test/test-runner.js` — assertion harness imported by each test.

The two never get confused at runtime: the runner is the orchestrator,
the harness is the framework.

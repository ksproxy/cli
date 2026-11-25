# Development: tests and coverage

The README has the short version. This page lists how the tests run, how to find code that no test reaches, and the stand-in programs the tests use.

```
npm test
```

**Contents**

- [The layout](#the-layout)
- [Coverage](#coverage)
- [Stand-in programs](#stand-in-programs)

## The layout

- The complete logic, module by module, is drawn as Mermaid diagrams in [LOGIC.md](LOGIC.md). `test/logic-docs.test.js` fails when a module or an exported function is missing from it.
- Each kind of target is one folder, and the core walks the list of kinds. How to add a kind is in [KINDS.md](KINDS.md).

```
src/kinds/index.js         the ordered list of kinds
src/kinds/<name>/index.js  one kind: ssh, kubernetes, local or one of the service kinds
src/kinds/<name>/*.js      the mechanics of that kind (master.js, cluster.js, folder.js)
src/kinds/engines/*.js     what several kinds share (http, http-service, command, resp, sql, sql-service, mcp-client, doctor)
src/*.js                   the core: inventory, start, tools, review, audit, cli
test/fixtures/kind-echo.js a test-only kind, the smallest example
```

## Coverage

- **No dependencies to install.** `package.json` has none, and tests use only `node:test` and `node:assert/strict`.
- **Coverage must stay at 100%.** `npm test` runs `node --test` with Node's built-in coverage over `src/` and `bin/`, and it fails when line, branch or function coverage is below 100%. A change that adds code needs tests that reach it.
- **Finding missed lines.** Run the suite with the coverage report and read the "uncovered lines" column. Quote the globs so Node, not the shell, expands them:

  ```
  node --test --experimental-test-coverage --test-coverage-include='src/**' --test-coverage-include='bin/**' 'test/*.test.js'
  ```

- **Finding missed branches.** Branch gaps do not show up in that column. A file below 100% in "branch %" has an untested `if`, `?:`, `??` or `catch`, so read the code around its other lines. For a per-branch listing, add `--test-reporter=lcov --test-reporter-destination=coverage.lcov` and look for `BRDA` entries that end in `,0`.
- **Most tests call the code in the test's own process,** so the coverage counts. `start` and `main` take an optional last argument (a process-like object, and for `start` also the checkbox, the health probe and the close time limits), which the tests use to drive signals, streams and timers; the defaults are the real ones.
- **Only `bin/ksproxy.js` runs in a child process,** and its coverage reaches the report because those tests pass `NODE_V8_COVERAGE` through to the child.

## Stand-in programs

No test contacts a real server or cluster. `ssh` and `kubectl` are replaced through `KSPROXY_SSH` and `KSPROXY_KUBECTL` with the stubs in `test/fixtures/`. The service kinds have stand-ins too: `fake-psql.js`, `fake-mysql.js`, `fake-mongosh.js`, `fake-client.js` and `fake-kafka.js` for the client programs, `resp-server.js` for Redis, `mcp-server.js` for an MCP server, and `self-signed.js` for the TLS tests. The first four stubs are:

| Stub | What it does |
|---|---|
| `fake-ssh.js` | Creates and removes the control socket file and answers `-O check` and `-O exit`. It prints `ran <name> <command>` for an exec, and `fail` and `slow` commands give exit 3 and a 10 second wait. `KSPROXY_FAKE_SSH_CHECK_MS` delays each `-O check` answer, and `KSPROXY_FAKE_SSH_TRACE` appends `begin` and `end` to a file around it, which the health-check test uses to show that two checks never overlap. |
| `fake-kubectl.js` | Listens on the `--port` given to `proxy` and answers every request with `KSPROXY_FAKE_KUBECTL_STATUS` (default 200). For any other call it prints its arguments as JSON. |
| `fake-ssh-nostay.js` | Opens a master without leaving a socket, so `-O check` fails. |
| `fake-ssh-flood.js` | Prints 300000 bytes. |

- **No test touches your home folder.** Each test passes its own environment with `KSPROXY_CONFIG_DIR` and `KSPROXY_STATE_DIR` pointing into a fresh directory under `/tmp`.
- **Real programs in temporary folders.** The local-target tests run real programs (`cat`, `ls`, `env` and small node scripts) in temporary folders.

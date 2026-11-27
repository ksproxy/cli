import test from 'node:test';
import assert from 'node:assert/strict';
import { InventoryError } from '../src/checks.js';
import {
  MAX_ARGUMENT_BYTES, checkMcpAllow, checkPinned, decideCall, describeRule, describeRules, readCall, regexWarnings, sortedJson,
} from '../src/kinds/mcp/rules.js';
import { pinProblem } from '../src/kinds/mcp/pin.js';
import {
  INPUT_REQUIRED, answerOf, cutBytes, endText,
} from '../src/kinds/mcp/answer.js';
import {
  MAX_EXPORTED, SESSION_BUDGET, cleanText, exportTools, indexTools, isDuplicate, toolsFileText,
} from '../src/kinds/mcp/export.js';

const W = 'mcp "jira"';
const allowOf = (allow) => checkMcpAllow({ allow }, W);
const refusedWith = (fn, text) => assert.throws(fn, (err) => err instanceof InventoryError && err.message === text);

test('rules: a tool name or an object with tool and arguments; every refusal of the inventory', () => {
  assert.deepEqual(checkMcpAllow({}, W), []);
  assert.deepEqual(allowOf([]), []);
  assert.deepEqual(allowOf(['jira_get_issue', 'a.b-c_1', { tool: 'x' }, { tool: 'y', arguments: { n: 1, b: true, s: 'S', star: '*', lit: '\\*', re: 'regex(SHOP-[0-9]+)' } }]), [
    'jira_get_issue', 'a.b-c_1', { tool: 'x', arguments: {} },
    { tool: 'y', arguments: { n: 1, b: true, s: 'S', star: '*', lit: '\\*', re: 'regex(SHOP-[0-9]+)' } },
  ]);
  refusedWith(() => allowOf('any'), `${W}: allow: "any" is not supported for mcp targets; list the tools`);
  refusedWith(() => allowOf('jira_get_issue'), `${W}: allow: must be a list of rules: a tool name, or {"tool": NAME, "arguments": {...}}`);
  const nameError = `${W}: allow[0]: must be a tool name of letters, digits and _ . - (at most 128 characters), or {"tool": NAME, "arguments": {...}}`;
  for (const bad of ['', 'a b', 'regex(x)', 'jira/get', 'x'.repeat(129), 42, null, ['x']]) refusedWith(() => allowOf([bad]), nameError);
  refusedWith(() => allowOf([{ tool: 'x', extra: 1 }]), `${W}: allow[0]: unknown key "extra"`);
  refusedWith(() => allowOf([{ arguments: {} }]), `${W}: allow[0]: tool: must be a tool name of letters, digits and _ . - (at most 128 characters)`);
  refusedWith(() => allowOf([{ tool: 'a b' }]), `${W}: allow[0]: tool: must be a tool name of letters, digits and _ . - (at most 128 characters)`);
  const named = `${W}: allow[0]: arguments: must be an object of at most 50 arguments`;
  refusedWith(() => allowOf([{ tool: 'x', arguments: [] }]), named);
  refusedWith(() => allowOf([{ tool: 'x', arguments: 'a' }]), named);
  refusedWith(() => allowOf([{ tool: 'x', arguments: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`a${i}`, 1])) }]), named);
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const rule = JSON.parse(`{"tool": "x", "arguments": {"${key}": "*"}}`);
    refusedWith(() => allowOf([rule]), `${W}: allow[0]: arguments: "${key}" is not an argument name ksproxy takes`);
  }
  refusedWith(() => allowOf([{ tool: 'x', arguments: { 'a b': 1 } }]), `${W}: allow[0]: arguments: "a b" must be an argument name of letters, digits and _ . - (at most 64 characters)`);
  refusedWith(() => allowOf([{ tool: 'x', arguments: { [`a${'b'.repeat(70)}`]: 1 } }]), `${W}: allow[0]: arguments: "a${'b'.repeat(62)}\u2026" must be an argument name of letters, digits and _ . - (at most 64 characters)`);
  const value = `${W}: allow[0]: arguments.k: must be a string of at most 1000 characters, a number, true or false`;
  for (const bad of [null, [], {}, 'x'.repeat(1001)]) refusedWith(() => allowOf([{ tool: 'x', arguments: { k: bad } }]), value);
  refusedWith(() => allowOf([{ tool: 'x', arguments: { k: 'regex(abc' } }]), `${W}: allow[0]: arguments.k: regex(...) must be the whole value`);
  refusedWith(() => allowOf([{ tool: 'x', arguments: { k: 'regex( )' } }]), `${W}: allow[0]: arguments.k: the regex pattern is empty`);
  assert.throws(() => allowOf([{ tool: 'x', arguments: { k: 'regex(a[)' } }]), /^Error: mcp "jira": allow\[0\]: arguments.k: the regex does not compile: /);
  assert.throws(() => allowOf([{ tool: 'x', arguments: { k: 'regex(a)|(b)' } }]), /the regex does not compile/);
});

test('pinned arguments: names as in rules, values a string, a number or a boolean', () => {
  assert.deepEqual(checkPinned(undefined, W), {});
  assert.deepEqual(checkPinned({ cloudId: 'abc', n: 2, b: false }, W), { cloudId: 'abc', n: 2, b: false });
  const bad = `${W}: arguments.k: must be a string of at most 1000 characters, a number, true or false`;
  for (const value of [null, {}, [1], 'x'.repeat(1001)]) refusedWith(() => checkPinned({ k: value }, W), bad);
  refusedWith(() => checkPinned(JSON.parse('{"__proto__": 1}'), W), `${W}: arguments: "__proto__" is not an argument name ksproxy takes`);
  refusedWith(() => checkPinned([], W), `${W}: arguments: must be an object of at most 50 arguments`);
});

test('readCall: the call is an object of tool and arguments, nothing else', () => {
  const refused = (input, reason, short) => assert.deepEqual(readCall(input), { refusal: { allowed: false, reason, short } });
  refused('x', 'the call must be an object with tool and arguments', 'invalid call');
  refused(null, 'the call must be an object with tool and arguments', 'invalid call');
  refused({ tool: 'x', extra: 1 }, 'the call has the unknown field "extra"; give tool and arguments', 'invalid call');
  refused({ arguments: {} }, 'tool must be the name of a tool of this MCP server: letters, digits and _ . -', 'invalid tool name');
  refused({ tool: '../x' }, 'tool must be the name of a tool of this MCP server: letters, digits and _ . -', 'invalid tool name');
  refused({ tool: 'x', arguments: [] }, 'arguments must be a JSON object', 'invalid arguments');
  refused({ tool: 'x', arguments: 'a' }, 'arguments must be a JSON object', 'invalid arguments');
  refused({ tool: 'x', arguments: { a: 'y'.repeat(MAX_ARGUMENT_BYTES) } }, 'the arguments are larger than 196608 bytes of JSON', 'arguments too large');
  const deep = JSON.parse(`{"a": ${'['.repeat(300000)}${']'.repeat(300000)}}`);
  refused({ tool: 'x', arguments: deep }, 'the arguments cannot be written as JSON', 'invalid arguments');
  assert.deepEqual(readCall({ tool: 'x' }), { call: { tool: 'x', arguments: {} } });
  assert.deepEqual(readCall({ tool: 'x', arguments: { a: 1 } }), { call: { tool: 'x', arguments: { a: 1 } } });
});

test('decideCall: every rule form and value form, pinned arguments and prototype keys', () => {
  const allow = allowOf([
    'get_issue',
    { tool: 'add_comment', arguments: { issue_key: 'regex(SHOP-[0-9]+)' } },
    { tool: 'search', arguments: { jql: '*' } },
    { tool: 'star', arguments: { v: '\\*' } },
    { tool: 'exact', arguments: { s: 'a b', n: 5, b: true } },
    { tool: 'json', arguments: { f: 'regex(\\{"a":1,"b":\\[1,2\\]\\})' } },
  ]);
  const target = { allow, arguments: {} };
  const decide = (tool, args) => decideCall(target, { tool, arguments: args });
  const allowed = (tool, args, rule) => assert.deepEqual(decide(tool, args), { allowed: true, rule });
  const refused = (tool, args, reason) => assert.deepEqual(decide(tool, args), { allowed: false, reason, short: 'not on allowlist' });
  const listed = 'Allowed: get_issue; add_comment {"issue_key":"regex(SHOP-[0-9]+)"}; search {"jql":"*"}; star {"v":"\\\\*"}; exact {"s":"a b","n":5,"b":true}; json {"f":"regex(\\\\{\\"a\\":1,\\"b\\":\\\\[1,2\\\\]\\\\})"}';
  allowed('get_issue', { anything: [1, 2] }, 'get_issue');
  allowed('add_comment', { issue_key: 'SHOP-12', body: 'free' }, 'add_comment {"issue_key":"regex(SHOP-[0-9]+)"}');
  refused('add_comment', { issue_key: 'SHOP-12 OR x' }, `no rule allows add_comment with these arguments. ${listed}`);
  refused('add_comment', { issue_key: 'HR-1' }, `no rule allows add_comment with these arguments. ${listed}`);
  refused('add_comment', {}, `no rule allows add_comment with these arguments. ${listed}`);
  refused('add_comment', { issue_key: 'S'.repeat(1001) }, `no rule allows add_comment with these arguments. ${listed}`);
  allowed('search', { jql: null }, 'search {"jql":"*"}');
  refused('search', {}, `no rule allows search with these arguments. ${listed}`);
  allowed('star', { v: '*' }, 'star {"v":"\\\\*"}');
  refused('star', { v: 'x' }, `no rule allows star with these arguments. ${listed}`);
  allowed('exact', { s: 'a b', n: 5, b: true }, 'exact {"s":"a b","n":5,"b":true}');
  refused('exact', { s: 'a b', n: '5', b: true }, `no rule allows exact with these arguments. ${listed}`);
  refused('exact', { s: 'a b', n: 5, b: 'true' }, `no rule allows exact with these arguments. ${listed}`);
  // A value that is not a string is matched as compact JSON with sorted keys.
  allowed('json', { f: { b: [1, 2], a: 1 } }, 'json {"f":"regex(\\\\{\\"a\\":1,\\"b\\":\\\\[1,2\\\\]\\\\})"}');
  refused('delete_issue', {}, `no rule allows delete_issue. ${listed}`);
  // A key of the object prototype in the call is an ordinary argument: it never reads the prototype.
  const proto = JSON.parse('{"__proto__": {"issue_key": "SHOP-1"}, "constructor": "x"}');
  refused('add_comment', proto, `no rule allows add_comment with these arguments. ${listed}`);
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  const ctor = decideCall({ allow: allowOf([{ tool: 'x', arguments: { k: '*' } }]), arguments: {} }, { tool: 'x', arguments: proto });
  assert.equal(ctor.allowed, false);

  assert.deepEqual(decideCall({ allow: [], arguments: {} }, { tool: 'x' }), {
    allowed: false, reason: 'the allowlist for this target is empty, so every call is refused', short: 'allowlist is empty',
  });
  assert.deepEqual(decideCall(target, { tool: 'x', more: 1 }).short, 'invalid call');

  const pinnedTarget = { allow: allowOf([{ tool: 'site', arguments: { cloudId: 'c1' } }]), arguments: { cloudId: 'c1' } };
  assert.deepEqual(decideCall(pinnedTarget, { tool: 'site' }), { allowed: true, rule: 'site {"cloudId":"c1"}' });
  assert.deepEqual(decideCall(pinnedTarget, { tool: 'site', arguments: { cloudId: 'c1' } }), { allowed: true, rule: 'site {"cloudId":"c1"}' });
  assert.deepEqual(decideCall(pinnedTarget, { tool: 'site', arguments: { cloudId: 'c2' } }), {
    allowed: false, reason: 'the argument cloudId is fixed to "c1" for this target; leave it out', short: 'fixed argument differs',
  });
  // A rule that names the tool only is checked without the target's pinned arguments being required.
  assert.deepEqual(decideCall({ allow: ['site'] }, { tool: 'site' }), { allowed: true, rule: 'site' });
});

test('sortedJson, describeRule, describeRules and regexWarnings', () => {
  assert.equal(sortedJson({ b: [1, { d: 1, c: null }], a: 'x' }), '{"a":"x","b":[1,{"c":null,"d":1}]}');
  assert.equal(sortedJson('x'.repeat(2000), 10).length, 10);
  const deep = JSON.parse(`${'['.repeat(100000)}${']'.repeat(100000)}`);
  assert.equal(sortedJson(deep), '['.repeat(1001));
  assert.equal(describeRule('a'), 'a');
  assert.equal(describeRule({ tool: 'a', arguments: {} }), 'a');
  assert.equal(describeRules([]), 'nothing (empty allowlist)');
  assert.equal(describeRules(Array.from({ length: 300 }, (_, i) => `tool_${i}`)).length, 1000);
  assert.deepEqual(regexWarnings(allowOf(['a', { tool: 'b', arguments: { x: 'regex((a+)+)', y: 'regex(a)', n: 1 } }])), [
    'allow[1].arguments.x: this pattern can be very slow on some inputs',
  ]);
});

const pinned = [
  ['npx', '-y', 'mcp-server-x@1.2.3'],
  ['/opt/bin/NPX', '-y', 'mcp-server-x@1.2.3'],
  ['/usr/local/bin/npx', '--yes', '@scope/server@1.2.3-beta.1+build.5'],
  ['npx', '-q', '--', 'server@0.0.1'],
  ['npx', '-p', 'server@1.0.0', '-p', '@scope/other@2.0.0', 'server-bin', '--flag', 'x'],
  ['npx', '--package=server@1.0.0', 'server-bin'],
  ['npx', '--no', 'server@1.0.0'],
  ['bunx', '--bun', 'server@1.0.0'],
  ['bunx', '--silent', '--verbose', '--no-install', '-p', 'server@1.0.0', 'cmd'],
  ['uvx', 'mcp-atlassian@0.24.8'],
  ['uvx', 'pkg[extra,two]@1.2.3rc1'],
  ['uvx', '--from', 'mcp-atlassian==0.24.8', 'mcp-atlassian'],
  ['uvx', '--from=pkg@1.2.3.post1', '--with', 'dep==2.0', '--with=other==1.0.dev3', 'cmd', '--any', 'arg'],
  ['uvx', '--python', '3.12', '-p', '3.12', '--exclude-newer', '2026-11-01', '--isolated', '--no-cache', '-n', '-q', '--quiet', '-v', '--verbose', '--offline', '--refresh', '--no-progress', '--native-tls', 'pkg@1.0'],
  ['pipx', 'run', '--spec', 'pkg==1.2.3', 'cmd'],
  ['pipx', 'run', '--python', '3.12', '--no-cache', '-v', '--verbose', '-q', '--quiet', '--system-site-packages', 'pkg==1.2.3'],
  ['docker', 'run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server:v2.2.0'],
  ['docker', 'run', '--interactive', '--rm', '--env=A=b', 'host:5000/team/img:1.2'],
  ['podman', 'run', '-i', '--rm', `img@sha256:${'a'.repeat(64)}`],
  ['podman', 'run', '-i', '--rm', '--init', '--read-only', '-q', '--privileged', '--no-healthcheck', `img:latest@sha256:${'b'.repeat(64)}`],
  ['github-mcp-server', 'stdio', '--read-only', '--toolsets', 'issues'],
  ['/opt/node', 'server.js'],
  ['python3', 'server.py'],
  ['python3', '-m', 'my_server'],
  ['python3', 'server.py', '-m', 'uv'],
  // Only options and no script, or -m with nothing after it: nothing for the check to refuse.
  ['python3', '-u'],
  ['python3', '-m'],
  ['python3', '-u', '-X', 'dev', 'server.py'],
  ['nerdctl', 'run', '-i', '--rm', 'img:1.2'],
  ['/usr/local/bin/finch', 'run', '-i', '--rm', `img@sha256:${'c'.repeat(64)}`],
  ['go', 'run', 'github.com/example/server@v1.2.3', '--user=someone@example.com'],
  ['go', 'run', '-mod=mod', 'example.com/x/server@v0.4.0-rc.1'],
  ['go', 'run', '/srv/server/main.go'],
  ['go', 'tool', 'example-server'],
];

const refusedPins = [
  [['npx', 'server'], 'npx runs server without an exact version; write the package as name@1.2.3 or @scope/name@1.2.3'],
  [['NPX', 'server'], 'npx runs server without an exact version; write the package as name@1.2.3 or @scope/name@1.2.3'],
  [['/opt/bin/Uvx', 'server'], 'uvx runs server without an exact version; write name@1.2.3, or --from \'name==1.2.3\' and the command'],
  [['npx', '-y', 'server@latest'], 'npx runs server@latest without an exact version; write the package as name@1.2.3 or @scope/name@1.2.3'],
  [['npx', 'server@^1.2.3'], 'npx runs server@^1.2.3 without an exact version; write the package as name@1.2.3 or @scope/name@1.2.3'],
  [['npx', 'github:user/repo'], 'npx runs github:user/repo without an exact version; write the package as name@1.2.3 or @scope/name@1.2.3'],
  [['npx', '-p', 'server', 'cmd'], 'npx -p server has no exact version; write the package as name@1.2.3 or @scope/name@1.2.3'],
  [['npx', '-y'], 'npx names nothing to run; write the package as name@1.2.3 or @scope/name@1.2.3'],
  [['npx', '-p'], 'npx -p needs a value'],
  [['npx', '-c', 'evil'], 'npx -c runs a shell command'],
  [['npx', '--call=evil'], 'npx --call runs a shell command'],
  [['npx', '--registry', 'x', 'a@1.0.0'], 'ksproxy does not know the option --registry of npx; it reads every option so that nothing unpinned runs'],
  [['npx', '--yes=true', 'a@1.0.0'], 'ksproxy does not know the option --yes=true of npx; it reads every option so that nothing unpinned runs'],
  [['bunx', 'server@1'], 'bunx runs server@1 without an exact version; write the package as name@1.2.3 or @scope/name@1.2.3'],
  [['uvx', 'mcp-atlassian'], 'uvx runs mcp-atlassian without an exact version; write name@1.2.3, or --from \'name==1.2.3\' and the command'],
  [['uvx', 'pkg@latest'], 'uvx runs pkg@latest without an exact version; write name@1.2.3, or --from \'name==1.2.3\' and the command'],
  [['uvx', 'pkg==1.2.3'], 'uvx runs pkg==1.2.3 without an exact version; write name@1.2.3, or --from \'name==1.2.3\' and the command'],
  [['uvx', '--from', 'pkg==1.2.*', 'cmd'], 'uvx --from pkg==1.2.* has no exact version; write name@1.2.3, or --from \'name==1.2.3\' and the command'],
  [['uvx', '--from', 'git+https://example.com/x.git', 'cmd'], 'uvx --from git+https://example.com/x.git has no exact version; write name@1.2.3, or --from \'name==1.2.3\' and the command'],
  [['uvx', '--from', './local', 'cmd'], 'uvx --from ./local has no exact version; write name@1.2.3, or --from \'name==1.2.3\' and the command'],
  [['uvx', '--from', 'pkg>=1.0', 'cmd'], 'uvx --from pkg>=1.0 has no exact version; write name@1.2.3, or --from \'name==1.2.3\' and the command'],
  [['uvx', '--with', 'dep', 'pkg@1.0'], 'uvx --with dep has no exact version; write name@1.2.3, or --from \'name==1.2.3\' and the command'],
  [['uvx', '--with-requirements', 'r.txt', 'pkg@1.0'], 'uvx --with-requirements reads its packages from a file, which ksproxy cannot check'],
  [['uvx', '--with-editable', '.', 'pkg@1.0'], 'uvx --with-editable runs a package from a folder, which ksproxy cannot check'],
  [['uvx', '--index-url', 'https://example.com', 'pkg@1.0'], 'ksproxy does not know the option --index-url of uvx; it reads every option so that nothing unpinned runs'],
  [['uvx', '--from', 'pkg==1.0'], 'uvx names nothing to run; write name@1.2.3, or --from \'name==1.2.3\' and the command'],
  [['pipx', 'install', 'pkg==1.0'], 'pipx is accepted only as pipx run; write --spec name==1.2.3 and the command, or name==1.2.3'],
  [['pipx', 'run', 'pkg'], 'pipx run runs pkg without an exact version; write --spec name==1.2.3 and the command, or name==1.2.3'],
  [['pipx', 'run', '--spec', 'pkg', 'cmd'], 'pipx run --spec pkg has no exact version; write --spec name==1.2.3 and the command, or name==1.2.3'],
  [['pipx', 'run', '--pip-args=--pre', 'pkg==1.0'], 'pipx run --pip-args passes options to pip, which ksproxy cannot check'],
  [['pipx', 'run'], 'pipx run names nothing to run; write --spec name==1.2.3 and the command, or name==1.2.3'],
  [['docker', 'pull', 'img:1'], 'docker is accepted only as docker run -i --rm IMAGE:TAG'],
  [['docker', 'run', '--rm', 'img:1'], 'docker run needs -i, so that the server reads its messages'],
  [['docker', 'run', '-i', 'img:1'], 'docker run needs --rm, so that no container is left behind'],
  [['docker', 'run', '-i', '--rm'], 'docker run names no image; write the image with a tag other than latest (name:1.2.3) or a digest (name@sha256:...)'],
  [['docker', 'run', '-i', '--rm', 'img'], 'docker runs the image img without a fixed tag; write the image with a tag other than latest (name:1.2.3) or a digest (name@sha256:...)'],
  [['docker', 'run', '-i', '--rm', 'img:latest'], 'docker runs the image img:latest without a fixed tag; write the image with a tag other than latest (name:1.2.3) or a digest (name@sha256:...)'],
  [['docker', 'run', '-i', '--rm', 'host:5000/img'], 'docker runs the image host:5000/img without a fixed tag; write the image with a tag other than latest (name:1.2.3) or a digest (name@sha256:...)'],
  [['docker', 'run', '-i', '--rm', 'img:'], 'docker runs the image img: without a fixed tag; write the image with a tag other than latest (name:1.2.3) or a digest (name@sha256:...)'],
  [['docker', 'run', '-i', '--rm', 'img@sha256:abc'], 'docker runs the image img@sha256:abc without a fixed tag; write the image with a tag other than latest (name:1.2.3) or a digest (name@sha256:...)'],
  [['docker', 'run', '-it', '--rm', 'img:1'], 'ksproxy does not know the option -it of docker run; it reads every option so that nothing unpinned runs'],
  [['docker', 'run', '-i', '-t', '--rm', 'img:1'], 'docker run -t gives the server a terminal, which breaks its messages'],
  [['podman', 'run', '-i', '--rm', '--detach', 'img:1'], 'podman run --detach runs the server in the background, away from ksproxy'],
  [['podman', 'run', '-i', '--rm', '-e'], 'podman run -e needs a value'],
  [['docker', '--context', 'x', 'run', '-i', '--rm', 'img:1'], 'docker is accepted only as docker run -i --rm IMAGE:TAG'],
  [['npm', 'exec', 'pkg@1.0.0'], 'npm is not accepted: it can download and run a package that ksproxy cannot see pinned; use npx with an exact version'],
  [['npm', '--yes', 'x', 'pkg@1.0.0'], 'npm is not accepted: it can download and run a package that ksproxy cannot see pinned; use npx with an exact version'],
  [['npm', '--prefix', '/x', 'exec', 'pkg'], 'npm is not accepted: it can download and run a package that ksproxy cannot see pinned; use npx with an exact version'],
  [['npm', 'exe', 'pkg'], 'npm is not accepted: it can download and run a package that ksproxy cannot see pinned; use npx with an exact version'],
  [['npm', 'create', 'pkg'], 'npm is not accepted: it can download and run a package that ksproxy cannot see pinned; use npx with an exact version'],
  [['npm', 'init', 'pkg'], 'npm is not accepted: it can download and run a package that ksproxy cannot see pinned; use npx with an exact version'],
  [['npm', 'start'], 'npm is not accepted: it can download and run a package that ksproxy cannot see pinned; use npx with an exact version'],
  [['pnpm', '--dir', '/x', 'dlx', 'pkg'], 'pnpm is not accepted: it can download and run a package that ksproxy cannot see pinned; use npx with an exact version'],
  [['pnpx', 'pkg@1.0.0'], 'pnpx is not accepted: it can download and run a package that ksproxy cannot see pinned; use npx with an exact version'],
  [['yarn', '--cwd', '/x', 'dlx', 'pkg'], 'yarn is not accepted: it can download and run a package that ksproxy cannot see pinned; use npx with an exact version'],
  [['bun', 'x', 'pkg@1.0.0'], 'bun is not accepted: it can download and run a package that ksproxy cannot see pinned; use bunx with an exact version'],
  [['bun', '/srv/mcp/server.ts'], 'bun is not accepted: it can download and run a package that ksproxy cannot see pinned; use bunx with an exact version'],
  [['/usr/bin/uv', 'tool', 'run', 'pkg@1.0'], 'uv is not accepted: it can download and run a package that ksproxy cannot see pinned; use uvx with an exact version, or python for a script of your own'],
  [['uv', '--directory', '/x', 'tool', 'run', 'pkg'], 'uv is not accepted: it can download and run a package that ksproxy cannot see pinned; use uvx with an exact version, or python for a script of your own'],
  [['uv', 'tool', 'uvx', 'pkg'], 'uv is not accepted: it can download and run a package that ksproxy cannot see pinned; use uvx with an exact version, or python for a script of your own'],
  [['uv', 'run', '--with', 'pkg', 'pkg'], 'uv is not accepted: it can download and run a package that ksproxy cannot see pinned; use uvx with an exact version, or python for a script of your own'],
  [['deno', 'run', 'npm:pkg'], 'deno is not accepted: it can download and run a package that ksproxy cannot see pinned; use npx with an exact version, or node for a script of your own'],
  [['nerdctl', 'run', '-i', '--rm', 'img'], 'nerdctl runs the image img without a fixed tag; write the image with a tag other than latest (name:1.2.3) or a digest (name@sha256:...)'],
  [['finch', 'pull', 'img:1'], 'finch is accepted only as finch run -i --rm IMAGE:TAG'],
  [['dnx', 'some.tool'], 'dnx is not accepted: it can download and run a package that ksproxy cannot see pinned; use npx, bunx, uvx or pipx run with an exact version, or a program you installed'],
  [['pixi', 'exec', 'pkg'], 'pixi is not accepted: it can download and run a package that ksproxy cannot see pinned; use npx, bunx, uvx or pipx run with an exact version, or a program you installed'],
  [['mise', 'x', 'pkg'], 'mise is not accepted: it can download and run a package that ksproxy cannot see pinned; use npx, bunx, uvx or pipx run with an exact version, or a program you installed'],
  [['corepack', 'pnpm', 'dlx', 'pkg'], 'corepack is not accepted: it can download and run a package that ksproxy cannot see pinned; use npx, bunx, uvx or pipx run with an exact version, or a program you installed'],
  [['go', 'run', 'github.com/example/server@latest'], 'go run runs github.com/example/server@latest without an exact version; write the module as path@v1.2.3'],
  [['go', 'run', '-mod=mod', 'example.com/x/server@v1'], 'go run runs example.com/x/server@v1 without an exact version; write the module as path@v1.2.3'],
  [['python3', '-m', 'pipx', 'run', 'pkg'], 'python3 -m pipx is not accepted: it can download and run a package that ksproxy cannot see pinned; use pipx run with an exact version'],
  [['/usr/bin/python3.12', '-m', 'uv', 'tool', 'run', 'pkg'], 'python3.12 -m uv is not accepted: it can download and run a package that ksproxy cannot see pinned; use uvx with an exact version'],
  [['python3', '-W', 'ignore', '-X', 'dev', '-m', 'uv', 'x'], 'python3 -m uv is not accepted: it can download and run a package that ksproxy cannot see pinned; use uvx with an exact version'],
  [['Python', '-mpipx', 'run', 'pkg'], 'Python -m pipx is not accepted: it can download and run a package that ksproxy cannot see pinned; use pipx run with an exact version'],
  // The program is found by its name in any letter case: a disk that ignores case runs npx for NPX.
  [['NPM', 'exec', 'pkg'], 'NPM is not accepted: it can download and run a package that ksproxy cannot see pinned; use npx with an exact version'],
  [['/opt/bin/Uv', 'tool', 'run', 'pkg'], 'Uv is not accepted: it can download and run a package that ksproxy cannot see pinned; use uvx with an exact version, or python for a script of your own'],
];

test('pinning: every form R10 accepts', () => {
  for (const argv of pinned) assert.equal(pinProblem(argv), null, argv.join(' '));
});

test('pinning: every form R10 refuses, failing closed on options it does not know', () => {
  for (const [argv, problem] of refusedPins) assert.equal(pinProblem(argv), problem, argv.join(' '));
});

test('answerOf: every part, every failure, isError, and the byte limit', () => {
  const at = { maxBytes: 1000, seconds: 60, hidden: [] };
  const result = (value, truncated = false) => answerOf({ result: value, truncated }, at);
  assert.deepEqual(result({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), {
    exitCode: 0, stdout: 'a\nb', stderr: '', truncated: false,
  });
  const data = Buffer.from('x'.repeat(41213)).toString('base64');
  const parts = [
    { type: 'image', data, mimeType: 'image/png' },
    { type: 'audio', data: 'AAA=', mimeType: 'audio/wav\u001b[31m' },
    { type: 'image', data: 42 },
    { type: 'resource', resource: { uri: 'file:///a', text: 'inside' } },
    { type: 'resource', resource: { uri: 'file:///b', blob: 'AAAA', mimeType: 'application/pdf' } },
    { type: 'resource_link', uri: 'https://example.com/a\nb' },
    { type: 'resource_link' },
    { type: 'text' },
    { type: 'video' },
    {},
    'plain',
  ];
  assert.deepEqual(result({ content: parts, isError: true }), {
    exitCode: 1,
    stdout: [
      '[image, image/png, 41213 bytes, not shown]', '[audio, audio/wav [31m, 2 bytes, not shown]', '[image, no type, 0 bytes, not shown]',
      'inside', '[resource, application/pdf, 3 bytes, not shown]', '[link: https://example.com/a b]', '[link: ]',
      '[a text part without text, not shown]', '[a part of type video, not shown]', '[a part of type none, not shown]',
      '[a part that is not an object, not shown]',
    ].join('\n'),
    stderr: '',
    truncated: false,
  });
  assert.deepEqual(result({ content: [], structuredContent: { b: 1, a: [2] } }).stdout, '{"b":1,"a":[2]}');
  assert.deepEqual(result({ structuredContent: 'x' }).stdout, '"x"');
  assert.deepEqual(result({ content: [{ type: 'image', data: 'AA==' }], structuredContent: [1] }).stdout, '[image, no type, 1 bytes, not shown]\n[1]');
  assert.deepEqual(result({ content: [{ type: 'text', text: 't' }], structuredContent: [1] }).stdout, 't');
  const deep = JSON.parse(`${'['.repeat(300000)}${']'.repeat(300000)}`);
  assert.deepEqual(result({ structuredContent: deep }).stdout, '[structured content that cannot be written as JSON, not shown]');
  assert.deepEqual(result({}), {
    exitCode: 0, stdout: '', stderr: '', truncated: false,
  });
  assert.deepEqual(result({ content: [{ type: 'text', text: 'é'.repeat(600) }] }, true), {
    exitCode: 0, stdout: 'é'.repeat(500), stderr: '', truncated: true,
  });
  assert.deepEqual(result({ content: [{ type: 'text', text: `a${'é'.repeat(600)}` }] }).stdout, `a${'é'.repeat(499)}`);

  const failed = (outcome, stderr) => assert.deepEqual(answerOf(outcome, at), { exitCode: 1, stdout: '', stderr });
  failed({ rpcError: { code: -32602, message: `bad\u0007 ${'m'.repeat(2000)}` } }, `the MCP server answered with an error: bad  ${'m'.repeat(994)}\u2026`);
  failed({ httpError: { status: 503, retryAfter: 30 } }, 'the MCP server answered HTTP 503, retry after 30 seconds');
  failed({ httpError: { status: 429, retryAfter: 0 } }, 'the MCP server answered HTTP 429, retry after 0 seconds');
  failed({ httpError: { status: 302, retryAfter: null } }, 'the MCP server answered HTTP 302');
  failed({ httpError: { status: 'x', retryAfter: -1 } }, 'the MCP server answered HTTP ?');
  failed({ httpError: { status: 500, retryAfter: '30 <b>body</b>' } }, 'the MCP server answered HTTP 500');
  failed({ unreachable: true }, 'the MCP server could not be reached');
  failed({ unreachable: true, reason: 'the connection was refused' }, 'the MCP server could not be reached: the connection was refused');
  failed({ unreachable: true, reason: { text: 'x' } }, 'the MCP server could not be reached');
  failed({ cutOff: true }, 'the answer of the MCP server was cut off');
  failed({ rpcError: { code: -32602, message: 'ksproxy cannot send this call: the value of Mcp-Param-Key is not printable' } }, 'ksproxy cannot send this call: the value of Mcp-Param-Key is not printable');
  failed({ ended: { code: 3, signal: null } }, 'the MCP server stopped (exit 3)');
  failed({ ended: { code: null, signal: 'SIGKILL' } }, 'the MCP server stopped (signal SIGKILL)');
  failed({ ended: { code: null, signal: null } }, 'the connection to the MCP server was closed');
  failed({ rpcError: { code: -32000, message: ' \u0007 ' } }, 'the MCP server answered with an error, without a message');
  failed({ inputRequired: true }, INPUT_REQUIRED);
  failed({ tooLarge: true }, 'the answer of the MCP server was too large to read');
  failed({}, 'the MCP server gave an answer that ksproxy cannot read');
  assert.deepEqual(answerOf({ timedOut: true }, { maxBytes: 10, seconds: 5, hidden: [] }), {
    exitCode: null, stdout: '', stderr: 'the MCP server did not answer within 5 seconds', timedOut: true, ownStderr: true,
  });
  assert.equal(endText({ code: 0, signal: null }), 'the MCP server stopped (exit 0)');
  assert.deepEqual(cutBytes('abc', 3), { text: 'abc', cut: false });
});

test('answerOf: each form of a secret is hidden before a server text is clipped, so the clip never shows a piece of it', () => {
  const secret = 'Qu0t3d"mcp\\value-0123';
  const escaped = JSON.stringify(secret).slice(1, -1);
  const basic = Buffer.from(`someone:${secret}`).toString('base64');
  const forms = [secret, escaped, basic];
  const at = { maxBytes: 100000, seconds: 60, hidden: forms };
  const shown = (text, form) => {
    assert.ok(!text.includes(form.slice(0, 4)), text.slice(-40));
    assert.ok(text.includes('[hid'), text.slice(-40));
  };
  for (const form of forms) {
    // A clip keeps max - 1 characters and adds an ellipsis: `before` characters of the form fall before the cut.
    for (const before of [4, 9, form.length - 1]) {
      const pad = 'x'.repeat(999 - before);
      shown(answerOf({ rpcError: { code: -32000, message: `${pad}${form} and more` } }, at).stderr, form);
      shown(answerOf({ rpcError: { code: -32602, message: `ksproxy cannot send this call: ${pad.slice(31)}${form} and more` } }, at).stderr, form);
      const uri = `https://shop.example.com/?q=${pad.slice(28)}${form}&more`;
      shown(answerOf({ result: { content: [{ type: 'resource_link', uri }] } }, at).stdout, form);
    }
    const short = 'x'.repeat(95);
    const parts = [
      { type: 'image', data: 'AAAA', mimeType: `${short}${form}` },
      { type: 'resource', resource: { blob: 'AAAA', mimeType: `${short}${form}` } },
      { type: `${short}${form}` },
    ];
    for (const part of parts) shown(answerOf({ result: { content: [part] } }, at).stdout, form);
  }
  // The exact texts: the secret hidden, then the clip. A start of a secret that the server itself wrote at the end is
  // shown as written, right or wrong: dropping it told the agent whether its own guess, repeated in an error, starts
  // the secret.
  assert.equal(answerOf({ rpcError: { code: -32000, message: `${'x'.repeat(995)}${secret} end` } }, at).stderr, `the MCP server answered with an error: ${'x'.repeat(995)}[hid\u2026`);
  for (const guess of [secret.slice(0, 12), `${secret.slice(0, 11)}#`]) {
    assert.equal(answerOf({ rpcError: { code: -32000, message: `token ${guess}` } }, at).stderr, `the MCP server answered with an error: token ${guess}`);
    assert.equal(answerOf({ result: { content: [{ type: 'resource_link', uri: `x://a/${guess}` }] } }, at).stdout, `[link: x://a/${guess}]`);
    assert.equal(answerOf({ rpcError: { code: -32000, message: `${'x'.repeat(999 - guess.length)}${guess} and more` } }, at).stderr, `the MCP server answered with an error: ${'x'.repeat(999 - guess.length)}${guess}\u2026`);
  }
  assert.equal(answerOf({ result: { content: [{ type: 'resource_link', uri: `https://shop.example.com/?k=${secret}` }] } }, at).stdout, '[link: https://shop.example.com/?k=[hidden]]');
});

const hidden = ['S3CR3T-value-0001'];
const toolOf = (name, extra = {}) => ({
  name, description: `Tool ${name}`, inputSchema: { type: 'object', properties: { key: { type: 'string' } } }, ...extra,
});

test('exportTools: what a rule names and the server lists, every reason a tool is not exported, and the notes', () => {
  const big = { type: 'object', properties: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`p${i}`, { type: 'string', description: 'x'.repeat(60) }])) };
  let nested = { type: 'string' };
  for (let i = 0; i < 70; i += 1) nested = { type: 'object', properties: { a: nested } };
  const tools = [
    toolOf('get_issue', {
      description: `Get\tone\u0007 issue \u202eevil\u202c\u{E0041} with S3CR3T-value-0001\nnext line ${'d'.repeat(2000)}`,
      inputSchema: {
        type: 'object',
        title: 'T\u200b',
        properties: {
          key: { type: 'string', description: 'the key\u2028S3CR3T-value-0001' },
          cloudId: { type: 'string' },
          'S3CR3T-value-0001': { type: 'string', enum: ['S3CR3T-value-0001'] },
          description: { type: 'string' },
        },
        required: ['key', 'cloudId'],
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
      title: 'Get issue',
    }),
    toolOf('no_description', { description: 42 }),
    toolOf('dotted.name'),
    toolOf('a_very_long_tool_name_that_passes_the_limit_of_fifty'),
    toolOf('array_schema', { inputSchema: { type: 'array' } }),
    toolOf('no_schema', { inputSchema: undefined }),
    toolOf('combined', { inputSchema: { type: 'object', anyOf: [] } }),
    toolOf('deep', { inputSchema: nested }),
    toolOf('large', { inputSchema: big }),
    toolOf('twice'),
    toolOf('twice'),
    toolOf('proto', { inputSchema: JSON.parse('{"type": "object", "properties": {"__proto__": {"type": "string"}}}') }),
    42,
    { name: 7 },
  ];
  const byName = indexTools(tools);
  assert.ok(isDuplicate(byName.get('twice')));
  assert.equal(byName.get('array_schema').properties, null);
  const target = {
    name: 'jira',
    allow: allowOf([
      'get_issue', { tool: 'get_issue', arguments: { key: '*', nope: '*' } }, 'no_description', 'dotted.name',
      'a_very_long_tool_name_that_passes_the_limit_of_fifty', 'array_schema', { tool: 'array_schema', arguments: { x: 1 } },
      'no_schema', 'combined', 'deep', 'large', 'twice', { tool: 'twice', arguments: { x: 1 } }, 'proto', 'missing',
    ]),
    arguments: { cloudId: 'c1' },
  };
  const { exported, notes } = exportTools(target, byName, hidden);
  assert.deepEqual(exported.map((item) => item.tool), ['get_issue', 'no_description', 'proto']);
  assert.deepEqual(notes, [
    'allow[1]: the tool get_issue declares no argument nope',
    'tool dotted.name is not exported: its name holds characters other than letters, digits, _ and -',
    'tool a_very_long_tool_name_that_passes_the_limit_of_fifty is not exported: jira__a_very_long_tool_name_that_passes_the_limit_of_fifty is longer than 50 characters',
    'tool array_schema is not exported: its input schema does not have type "object" at the top',
    'tool no_schema is not exported: its input schema does not have type "object" at the top',
    'tool combined is not exported: its input schema has oneOf, anyOf or allOf at the top',
    'tool deep is not exported: its input schema is nested more than 64 levels deep',
    'tool large is not exported: its input schema is larger than 64 KiB',
    'tool twice is not exported: the MCP server lists it more than once',
    'allow[14]: the MCP server does not list the tool missing',
  ]);
  const [get, none, proto] = exported.map((item) => item.definition);
  assert.deepEqual(Object.keys(get), ['name', 'description', 'inputSchema']);
  assert.equal(get.name, 'jira__get_issue');
  assert.ok(get.description.startsWith('[from the MCP server "jira"] Get one issue evil with [hidden]\nnext line ddd'), get.description);
  assert.equal(get.description.length, '[from the MCP server "jira"] '.length + 1000);
  assert.deepEqual(get.inputSchema, {
    type: 'object',
    title: 'T',
    properties: {
      key: { type: 'string', description: 'the key[hidden]' },
      '[hidden]': { type: 'string', enum: ['[hidden]'] },
      description: { type: 'string' },
    },
    required: ['key'],
    additionalProperties: false,
  });
  assert.equal(none.description, '[from the MCP server "jira"]');
  assert.equal(Object.getPrototypeOf(proto.inputSchema.properties), Object.prototype);
  assert.ok(Object.hasOwn(proto.inputSchema.properties, '__proto__'));
  assert.equal(JSON.stringify(proto.inputSchema), '{"type":"object","properties":{"__proto__":{"type":"string"}}}');
  assert.equal(cleanText('a\tb\u0000c\u200dd\ne', []), 'a bcd\ne');
});

test('exportTools: a hidden character in a key or a value of the schema keeps the tool out; description and title are cleaned', () => {
  const classes = {
    control: '\u0007', c1: '\u0085', format: '​', tag: '\u{E0041}', bidi: '‮', surrogate: '\ud800', line: ' ', paragraph: ' ', selector: '️', supplement: '\u{E0100}',
  };
  const reason = 'its input schema holds a hidden character (a control, format or variation selector character) in a key or in a value other than a description or a title';
  for (const [what, ch] of Object.entries(classes)) {
    const schemas = [
      { type: 'object', properties: { [`q${ch}`]: { type: 'string' } } },
      { type: 'object', properties: { q: { type: 'string', default: `x${ch}` } } },
      { type: 'object', properties: { q: { type: 'string', enum: ['a', `b${ch}`] } } },
      { type: 'object', properties: { q: { type: 'array', items: { examples: [[`e${ch}`]] } } } },
      { type: 'object', properties: { q: { type: 'string', pattern: `^a${ch}$` } } },
      { type: 'object', [`x-${ch}`]: 1 },
    ];
    schemas.forEach((inputSchema, i) => {
      const { exported, notes } = exportTools({ name: 'j', allow: ['t'], arguments: {} }, indexTools([{ name: 't', inputSchema }]), []);
      assert.deepEqual(exported, [], `${what} ${i}`);
      assert.deepEqual(notes, [`tool t is not exported: ${reason}`], `${what} ${i}`);
    });
    // In a description or a title the character is removed, as before.
    const tool = {
      name: 't',
      description: `A${ch}B`,
      inputSchema: {
        type: 'object', title: `T${ch}`, description: `D${ch}`, properties: { q: { type: 'string', description: `q${ch}`, title: `Q${ch}` } },
      },
    };
    const { exported } = exportTools({ name: 'j', allow: ['t'], arguments: {} }, indexTools([tool]), []);
    assert.deepEqual(exported[0].definition, {
      name: 'j__t',
      description: '[from the MCP server "j"] AB',
      inputSchema: {
        type: 'object', title: 'T', description: 'D', properties: { q: { type: 'string', description: 'q', title: 'Q' } },
      },
    }, what);
  }
  // A newline or a tab in a value is not hidden: the value goes as the server gave it.
  const plain = { type: 'object', properties: { q: { type: 'string', default: 'a\nb\tc', examples: ['x\ny'] } } };
  const kept = exportTools({ name: 'j', allow: ['t'], arguments: {} }, indexTools([{ name: 't', inputSchema: plain }]), []);
  assert.deepEqual(kept.exported[0].definition.inputSchema, plain);
  // A secret is hidden before the text is cleaned, so a tab in it does not save it; and again after, so a hidden
  // character inside it does not either.
  assert.equal(cleanText('key a\tb-secret-value end', ['a\tb-secret-value']), 'key [hidden] end');
  assert.equal(cleanText('key a-secret​-value end', ['a-secret-value']), 'key [hidden] end');
  assert.equal(cleanText('a️b\u{E01EF}c', []), 'abc');
  // A description whose secret crosses the clip of 1000 characters shows no piece of it.
  for (const form of ['S3CR3T-value-0001']) {
    const described = { name: 't', description: `${'d'.repeat(995)}${form} end`, inputSchema: { type: 'object' } };
    const { exported: [{ definition }] } = exportTools({ name: 'j', allow: ['t'], arguments: {} }, indexTools([described]), [form]);
    assert.equal(definition.description, `[from the MCP server "j"] ${'d'.repeat(995)}[hid…`);
  }
});

test('exportTools: at most MAX_EXPORTED tools a target, in the order the rules name them', () => {
  const tools = Array.from({ length: 500 }, (_, i) => toolOf(`tool_${i}`));
  const allow = allowOf([...Array.from({ length: 250 }, (_, i) => `tool_${249 - i}`), 'tool_249']);
  const { exported, notes } = exportTools({ name: 't', allow, arguments: {} }, indexTools(tools), []);
  assert.equal(exported.length, MAX_EXPORTED);
  assert.equal(exported[0].tool, 'tool_249');
  assert.deepEqual(notes, ['50 more tools that the rules name are not exported: a target exports at most 200']);
});

test('toolsFileText: the pid and start time, each tool with its target, and the budget of a session', () => {
  assert.equal(toolsFileText([], { pid: 1, processStartedAt: 2 }, () => assert.fail()), null);
  const definition = (name, size) => ({ name, description: 'd'.repeat(size), inputSchema: { type: 'object' } });
  const entry = (name, sizes) => ({
    target: { name, timeoutSeconds: 30 },
    live: { exported: sizes.map((size, i) => ({ tool: `t${i}`, definition: definition(`${name}__t${i}`, size) })) },
  });
  const cut = [];
  const entries = [entry('a', [100, 100]), entry('b', []), entry('c', [SESSION_BUDGET - 1000, 2000, 10]), entry('d', [10])];
  const text = toolsFileText(entries, { pid: 42, processStartedAt: null }, (e, count) => cut.push([e.target.name, count]));
  const file = JSON.parse(text);
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(Object.keys(file), ['version', 'pid', 'processStartedAt', 'tools']);
  assert.deepEqual([file.version, file.pid, file.processStartedAt], [1, 42, null]);
  assert.deepEqual(file.tools.map((t) => `${t.target}:${t.tool}:${t.timeoutSeconds}:${t.definition.name}`), ['a:t0:30:a__t0', 'a:t1:30:a__t1', 'c:t0:30:c__t0']);
  assert.deepEqual(cut, [['c', 2], ['d', 1]]);
});

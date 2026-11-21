import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import elasticsearch from '../src/kinds/elasticsearch/index.js';
import { KINDS, kindByFlag, kindByKey, kindByTool } from '../src/kinds/index.js';
import { checkKind } from './kind-contract.js';
import { InventoryError, validateInventory } from '../src/inventory.js';
import { callTool, toolDefinitions } from '../src/tools.js';
import { agentMdText } from '../src/agent-md.js';
import {
  auditOf, cli, closeServer, everythingOf, serviceWorld, startProvider, startService,
} from './http-service-helpers.js';
import {
  cleanupAll, launch, ready, stopWith,
} from './start-helpers.js';

const USER = 'es-user-S3CR3T-3f9a-unmistakable';
const PASSWORD = 'es-pw-S3CR3T-77c1-unmistakable';
const KEY = 'es-key-S3CR3T-a12b-unmistakable';
const b64 = (text) => Buffer.from(text).toString('base64');
const SECRETS = [USER, PASSWORD, KEY, b64(USER), b64(PASSWORD), b64(KEY), b64(`${USER}:${PASSWORD}`), b64(`ApiKey ${KEY}`)];
const EXAMPLE = ['GET /_cluster/health', 'GET /_cat/...', 'GET /logs-*/_search', 'POST /*/_search +body', 'GET /*/_mapping'];
const WIDE = ['* /...', '* /... +body', 'regex(.*)'];
const TOOL = 'elasticsearch_request';

let service;
let provider;
before(async () => {
  service = await startService();
  provider = await startProvider();
});
after(async () => {
  cleanupAll();
  await closeServer(service.server);
  await closeServer(provider.server);
});

const target = (allow = WIDE) => ({ allow });
const decideOf = (input, allow) => elasticsearch.decide(target(allow), input);

// Every fixed refusal as [method, path, body, short, a word of the reason].
const deepBody = (() => {
  let value = { script: 1 };
  for (let i = 0; i < 40; i += 1) value = { a: value };
  return { query: value };
})();
const deeperBody = (() => {
  let value = 1;
  for (let i = 0; i < 40; i += 1) value = { a: value };
  return value;
})();
const BANNED = ['_bulk', '_delete_by_query', '_update_by_query', '_reindex', '_scripts', '_snapshot', '_security', '_ingest', '_ilm', '_slm', '_license', '_xpack'];
const REFUSALS = [
  ...BANNED.flatMap((word) => [
    ['POST', `/${word}`, undefined, `${word} refused`],
    ['GET', `/logs/${word}/x`, undefined, `${word} refused`],
  ]),
  ['POST', '/_b%75lk', undefined, '_bulk refused'],
  ['POST', '/_BULK', undefined, '_bulk refused'],
  ['POST', '/_nodes/shutdown', undefined, 'node shutdown refused'],
  ['GET', '/_nodes/n1/shutdown', undefined, 'node shutdown refused'],
  ['POST', '/_nodes/reload_secure_settings', undefined, 'secure settings reload refused'],
  ['POST', '/_nodes/n1/reload_secure_settings', undefined, 'secure settings reload refused'],
  ['PUT', '/_cluster/settings', undefined, 'cluster settings change refused'],
  ['POST', '/_cluster/settings', undefined, 'cluster settings change refused'],
  ['HEAD', '/_cluster/settings', undefined, 'cluster settings change refused'],
  ['POST', '/_cluster/reroute', undefined, 'cluster reroute refused'],
  ['DELETE', '/_all', undefined, 'delete of _all refused'],
  ['DELETE', '/_all/_doc/1', undefined, 'delete of _all refused'],
  ['DELETE', '/_ALL', undefined, 'delete of _all refused'],
  ['DELETE', '/logs-2026', undefined, 'index delete refused'],
  ['DELETE', '/*', undefined, 'index delete refused'],
  ['DELETE', '/', undefined, 'index delete refused'],
  ['PUT', '/logs/_search', undefined, 'read-only endpoint'],
  ['DELETE', '/logs/_search', undefined, 'read-only endpoint'],
  ['PATCH', '/_search', undefined, 'read-only endpoint'],
  ['PUT', '/logs/_count', undefined, 'read-only endpoint'],
  ['DELETE', '/logs/_count', undefined, 'read-only endpoint'],
  ['PUT', '/_msearch', undefined, 'read-only endpoint'],
  ['PUT', '/logs/_mapping', undefined, 'read-only endpoint'],
  ['DELETE', '/logs/_mapping', undefined, 'read-only endpoint'],
  ['PUT', '/logs/_settings', undefined, 'read-only endpoint'],
  ['DELETE', '/logs/_settings', undefined, 'read-only endpoint'],
  ['POST', '/logs/_mapping', { properties: { f: { type: 'keyword' } } }, 'read-only endpoint'],
  ['POST', '/_mapping', undefined, 'read-only endpoint'],
  ['POST', '/logs/_settings', { index: { number_of_replicas: 0 } }, 'read-only endpoint'],
  ['PUT', '/logs/_mapping/_doc', undefined, 'read-only endpoint'],
  ['POST', '/logs/_mappings', undefined, 'read-only endpoint'],
  ['PUT', '/logs/_mappings/_doc', undefined, 'read-only endpoint'],
  ['POST', '/logs/_doc/_mappings', undefined, 'read-only endpoint'],
  ['PUT', '/logs/_settings/index.blocks.write', undefined, 'read-only endpoint'],
  ['DELETE', '/_MAPPING/x', undefined, 'read-only endpoint'],
  ['PUT', '/_xpack/security/user/eve', { password: 'x', roles: ['superuser'] }, '_xpack refused'],
  ['GET', '/_XPACK/license', undefined, '_xpack refused'],
  ['DELETE', '/_data_stream/logs-app', undefined, 'data stream delete refused'],
  ['DELETE', '/_Data_Stream/logs-*', undefined, 'data stream delete refused'],
  ['POST', '/_aliases', { actions: [{ add: { index: 'a', alias: 'b' } }, { remove_index: { index: 'logs' } }] }, 'index delete refused'],
  ['POST', '/_aliases', { actions: [{ Remove_Index: { index: 'logs' } }] }, 'index delete refused'],
  ['POST', '/logs/_search', { query: { terms_set: { f: { terms: [], minimum_should_match_script: { source: '1' } } } } }, 'script in body refused'],
  ['POST', '/logs/_search', { query: { function_score: { script_score: { source: '1' } } } }, 'script in body refused'],
  ['POST', '/logs/_search', { aggs: { a: { bucket_script: {} } } }, 'script in body refused'],
  ['POST', '/logs/_search', { aggs: { a: { significant_terms: { script_heuristic: {} } } } }, 'script in body refused'],
  ['POST', '/logs/_search', { query: { match: { Script: 1 } } }, 'script in body refused'],
  ['POST', '/logs/_search', { query: { match: { scripts: 'x' } } }, 'script in body refused'],
  ['POST', '/logs/_search', { runtime: { f: { type: 'keyword' } } }, 'script in body refused'],
  ['POST', '/logs/_search', { Runtime_Mappings: {} }, 'script in body refused'],
  ['POST', '/logs/_search', { query: { script: { source: 'x' } } }, 'script in body refused'],
  ['POST', '/logs/_search', { aggs: [{ ok: 1 }, { deep: { scripted_metric: { init_script: 'x' } } }] }, 'script in body refused'],
  ['POST', '/logs/_search', { runtime_mappings: { f: { type: 'keyword' } } }, 'script in body refused'],
  ['POST', '/logs/_search', { script_fields: { f: {} } }, 'script in body refused'],
  ['PUT', '/logs/_doc/1', { script: 1 }, 'script in body refused'],
  ['POST', '/logs/_search', deepBody, 'body too deep'],
  ['POST', '/logs/_search', deeperBody, 'body too deep'],
];

test('elasticsearch is a brokered kind after http and meets the contract', () => {
  assert.deepEqual(KINDS.map((kind) => kind.key).slice(0, 4), ['ssh', 'kubernetes', 'local', 'http']);
  assert.equal(kindByKey('elasticsearch'), elasticsearch);
  assert.equal(kindByFlag('es'), elasticsearch);
  assert.equal(kindByTool(TOOL), elasticsearch);
  checkKind(elasticsearch, KINDS);
  assert.equal(elasticsearch.brokered, true);
  assert.equal(elasticsearch.label, 'es');
  assert.equal(elasticsearch.tool.detailShape, 'object');
});

test('an elasticsearch entry is validated into a target, and every mistake is an inventory error that names the field', () => {
  const entry = (extra = {}) => ({ name: 'e', url: 'https://es.internal.example.com:9200', ...extra });
  const one = (extra) => validateInventory({ elasticsearch: [entry(extra)] }).elasticsearch[0];
  assert.deepEqual(validateInventory({
    elasticsearch: [entry({ userEnv: 'ES_USER', passwordEnv: 'ES_PASSWORD', allow: EXAMPLE })],
  }).elasticsearch[0], {
    kind: 'elasticsearch',
    name: 'e',
    baseUrl: 'https://es.internal.example.com:9200/',
    auth: { basicUserEnv: 'ES_USER', basicPasswordEnv: 'ES_PASSWORD' },
    description: '',
    allow: EXAMPLE,
  });
  assert.equal(one({}).auth, null);
  assert.deepEqual(one({}).allow, []);
  assert.equal(one({ allow: 'any' }).allow, 'any');
  assert.deepEqual(one({ apiKeyEnv: 'ES_KEY' }).auth, { apiKeyEnv: 'ES_KEY' });
  assert.equal(one({ description: 'logs' }).description, 'logs');
  assert.deepEqual(one({ allow: ['regex(GET /_cat /.*)', '* /...', 'POST /x +body'] }).allow, ['regex(GET /_cat /.*)', '* /...', 'POST /x +body']);
  const fails = (extra, message) => assert.throws(() => one(extra), (err) => {
    assert.ok(err instanceof InventoryError);
    assert.equal(err.message, message);
    return true;
  });
  fails({ baseUrl: 'https://x.example.com' }, 'elasticsearch "e": unknown key "baseUrl"');
  fails({ auth: {} }, 'elasticsearch "e": unknown key "auth"');
  fails({ url: undefined }, 'elasticsearch "e": url: must be a URL');
  fails({ url: 'http://es.example.com:9200' }, 'elasticsearch "e": url: must use https (http is accepted for localhost only)');
  fails({ url: 'https://u:p@es.example.com' }, 'elasticsearch "e": url: must not contain a user name, a password, a query or a fragment');
  fails({ userEnv: 'U' }, 'elasticsearch "e": userEnv and passwordEnv must be given together');
  fails({ passwordEnv: 'P' }, 'elasticsearch "e": userEnv and passwordEnv must be given together');
  const both = 'elasticsearch "e": give userEnv and passwordEnv, or apiKeyEnv, not both';
  fails({ userEnv: 'U', passwordEnv: 'P', apiKeyEnv: 'K' }, both);
  fails({ userEnv: 'U', apiKeyEnv: 'K' }, both);
  fails({ passwordEnv: 'P', apiKeyEnv: 'K' }, both);
  fails({ userEnv: 'lower', passwordEnv: 'P' }, 'elasticsearch "e": userEnv: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_');
  fails({ userEnv: 'HOME', passwordEnv: 'P' }, 'elasticsearch "e": userEnv: HOME is a variable the session needs; name a variable that must hold only the user name');
  fails({ userEnv: 'U', passwordEnv: 'SSH_X' }, 'elasticsearch "e": passwordEnv: SSH_X is a variable the session needs; name a variable that must hold only the password');
  fails({ userEnv: 'U', passwordEnv: 5 }, 'elasticsearch "e": passwordEnv: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_');
  fails({ apiKeyEnv: 'NODE_X' }, 'elasticsearch "e": apiKeyEnv: NODE_X is a variable the session needs; name a variable that must hold only the API key');
  fails({ apiKeyEnv: null }, 'elasticsearch "e": apiKeyEnv: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_');
  const rule = (i) => `elasticsearch "e": allow[${i}]: a rule is a method and a path, for example GET /_cat/indices, and may end in +body to allow a JSON body`;
  for (const bad of ['GET', 'get /x', 'GET x', 'GET /x extra', 'GET //x', 'GET /.../x', '...']) fails({ allow: ['GET /ok', bad] }, rule(1));
  let compileError = '';
  try {
    RegExp('GET (/x');
  } catch (err) {
    compileError = err.message;
  }
  fails({ allow: ['regex(GET (/x)'] }, `elasticsearch "e": allow[0]: regex does not compile: ${compileError}`);
  fails({ review: { reviewer: 'r1', policy: 'p', programs: ['ls'] } }, 'elasticsearch "e": review.programs: is only for local targets');
});

test('every fixed refusal is refused whatever the rules say, with its own text', () => {
  for (const [method, requestPath, body, short] of REFUSALS) {
    const input = body === undefined ? { method, path: requestPath } : { method, path: requestPath, body };
    for (const allow of [WIDE, 'any', ['regex(.*)']]) {
      const decision = decideOf(input, allow);
      assert.equal(decision.allowed, false, `${method} ${requestPath}`);
      assert.equal(decision.short, short, `${method} ${requestPath}`);
      assert.equal(decision.unmatched, undefined, 'a fixed refusal is never sent to the reviewer');
      assert.equal(decision.argv, undefined);
      assert.ok(decision.reason.length > 20 && decision.reason.endsWith('.'), decision.reason);
    }
  }
  const reasonOf = (method, requestPath, body) => decideOf({ method, path: requestPath, ...(body === undefined ? {} : { body }) }).reason;
  const sentence = (what) => `${what} is refused for every elasticsearch target, whatever the rules say.`;
  assert.equal(reasonOf('POST', '/_nodes/shutdown'), sentence('shutting a node down'));
  assert.equal(reasonOf('POST', '/_nodes/reload_secure_settings'), sentence('reloading secure settings'));
  assert.equal(reasonOf('PUT', '/_cluster/settings'), sentence('changing cluster settings'));
  assert.equal(reasonOf('POST', '/_cluster/reroute'), sentence('rerouting shards'));
  assert.equal(reasonOf('DELETE', '/_all'), sentence('DELETE on _all'));
  assert.equal(reasonOf('PUT', '/logs/_search'), sentence('PUT on a path that ends in _search'));
  assert.equal(reasonOf('POST', '/logs/_search', { script: 1 }), sentence('a "script" key in the body'));
  assert.equal(reasonOf('POST', '/logs/_search', { a: { script_fields: 1 } }), sentence('a "script_fields" key in the body'));
  assert.equal(reasonOf('POST', '/logs/_search', { [`${'s'.repeat(100)}script`]: 1 }), sentence(`a "${'s'.repeat(63)}…" key in the body`));
  assert.equal(reasonOf('POST', '/_aliases', { actions: [{ remove_index: { index: 'l' } }] }), sentence('a "remove_index" key in the body, which deletes an index,'));
  assert.equal(reasonOf('DELETE', '/_data_stream/x'), sentence('DELETE on _data_stream'));
  assert.equal(reasonOf('POST', '/logs/_mapping'), sentence('POST on a path with a _mapping segment'));
  assert.equal(reasonOf('PUT', '/logs/_mappings/_doc'), sentence('PUT on a path with a _mappings segment'));
  assert.equal(reasonOf('PUT', '/logs/_search'), sentence('PUT on a path that ends in _search'));
  assert.equal(reasonOf('POST', '/logs/_search', deeperBody), sentence('a body nested more than 32 levels'));
  assert.equal(decideOf({ method: 'POST', path: '/_bulk' }).reason, '_bulk is refused for every elasticsearch target, whatever the rules say.');
  assert.equal(decideOf({ method: 'DELETE', path: '/logs' }).reason, 'DELETE on an index is refused for every elasticsearch target, whatever the rules say.');
});

test('a body sent in the query as source is refused, and a method override in the query is refused by the reader', () => {
  for (const name of ['source', 'SOURCE', 'source_content_type', 'Source_Content_Type']) {
    for (const allow of [['GET /logs/_search'], 'any', WIDE]) {
      const decision = decideOf({ method: 'GET', path: '/logs/_search', query: { size: 1, [name]: '{"script_fields":{}}' } }, allow);
      assert.deepEqual(decision, {
        allowed: false,
        reason: `the query name "${name.toLowerCase()}" is refused for every elasticsearch target, whatever the rules say.`,
        short: 'body in query refused',
      });
    }
  }
  assert.equal(decideOf({ method: 'POST', path: '/logs/_search', query: { _Method: 'DELETE' } }).short, 'method override refused');
  assert.equal(decideOf({ method: 'GET', path: '/logs/_search', query: { sources: 'x', _source: 'f' } }).allowed, true);
});

test('what is near a fixed refusal but is not one is decided by the rules', () => {
  const ok = (input) => assert.equal(decideOf(input).allowed, true, JSON.stringify(input));
  ok({ method: 'GET', path: '/_cluster/settings' });
  ok({ method: 'GET', path: '/_cluster/reroute' });
  ok({ method: 'POST', path: '/_cluster/allocation/explain', body: {} });
  ok({ method: 'GET', path: '/_nodes/stats' });
  ok({ method: 'GET', path: '/_nodes/n1/stats' });
  ok({ method: 'DELETE', path: '/logs/_doc/1' });
  ok({ method: 'DELETE', path: '/logs/_alias/a' });
  ok({ method: 'GET', path: '/logs/_search' });
  ok({ method: 'HEAD', path: '/logs/_mapping' });
  ok({ method: 'GET', path: '/logs/_mappings/_doc' });
  ok({ method: 'GET', path: '/logs/_settings/index.number_of_replicas' });
  ok({ method: 'POST', path: '/logs/_search', body: { query: { match: { message: 'script' } } } });
  ok({ method: 'POST', path: '/logs/_search', body: { query: { match: { runtimes: 'x', remove: 1 } } } });
  ok({ method: 'POST', path: '/logs/_count', body: {} });
  ok({ method: 'POST', path: '/logs/_msearch', body: [] });
  ok({ method: 'GET', path: '/_data_stream/logs-app' });
  ok({ method: 'PUT', path: '/_data_stream/logs-app' });
  ok({ method: 'POST', path: '/_aliases', body: { actions: [{ remove: { index: 'a', alias: 'b' } }] } });
  ok({ method: 'POST', path: '/logs/_search', body: [1, 'script', null, { a: [{ b: 2 }] }] });
  ok({ method: 'PUT', path: '/logs/_doc/1', body: { field: 1 } });
  ok({ method: 'GET', path: '/logs/_bulkx' });
  ok({ method: 'GET', path: '/_cat/indices', query: { v: true } });
  assert.deepEqual(decideOf({ method: 'GET', path: '/a/../b' }), {
    allowed: false, reason: 'path may not contain a "." or ".." segment', short: 'dot segment',
  });
});

test('decide: one allowed read for each rule of the example, a body that needs +body, and a body that is never reviewed', () => {
  const call = (input) => decideOf(input, EXAMPLE);
  assert.deepEqual(call({ method: 'GET', path: '/_cluster/health', query: { level: 'indices' } }), {
    allowed: true, rule: 'GET /_cluster/health', argv: ['GET', '/_cluster', '/health', '?level=indices'],
  });
  assert.equal(call({ method: 'GET', path: '/_cat/indices' }).rule, 'GET /_cat/...');
  assert.equal(call({ method: 'GET', path: '/_cat/shards/logs' }).rule, 'GET /_cat/...');
  assert.equal(call({ method: 'GET', path: '/logs-*/_search' }).rule, 'GET /logs-*/_search');
  assert.equal(call({ method: 'GET', path: '/logs-2026/_search' }).allowed, false, 'a star inside a word is literal');
  assert.equal(call({ method: 'POST', path: '/logs-2026/_search', body: { size: 1 } }).rule, 'POST /*/_search +body');
  assert.equal(call({ method: 'GET', path: '/logs-2026/_mapping' }).rule, 'GET /*/_mapping');
  const noBody = call({ method: 'POST', path: '/logs/_search' });
  assert.equal(noBody.allowed, false);
  assert.equal(noBody.notReviewed, undefined);
  const withBody = call({ method: 'POST', path: '/logs/_count', body: {} });
  assert.deepEqual(withBody, {
    allowed: false,
    reason: `not on the allowlist for this target. Allowed: ${EXAMPLE.join('; ')}`,
    short: 'not on allowlist',
    unmatched: true,
    argv: ['POST', '/logs', '/_count', '+body'],
    notReviewed: 'a request with a body is not sent to the reviewer, who cannot see the body',
  });
  assert.equal(decideOf({ method: 'GET', path: '/x' }, []).short, 'allowlist is empty');
  assert.equal(decideOf({ method: 'GET', path: '/x' }, 'any').rule, 'any');
});

test('the session pieces: hint, opening line, secrets, open, record, messages and the agent notes', () => {
  const make = (auth, extra = {}) => ({
    kind: 'elasticsearch', name: 'e', baseUrl: 'https://es.internal.example.com:9200/', auth, description: 'logs', allow: ['GET /_cat/...'], ...extra,
  });
  assert.equal(elasticsearch.hint(make(null)), 'es.internal.example.com:9200 - logs');
  assert.equal(elasticsearch.hint(make(null, { description: '' })), 'es.internal.example.com:9200');
  const basic = { basicUserEnv: 'U', basicPasswordEnv: 'P' };
  assert.equal(elasticsearch.openingMessage(make(null)), 'https://es.internal.example.com:9200/, no auth');
  assert.equal(elasticsearch.openingMessage(make(basic)), 'https://es.internal.example.com:9200/, basic auth from U and P');
  assert.equal(elasticsearch.openingMessage(make({ apiKeyEnv: 'K' })), 'https://es.internal.example.com:9200/, API key from K');
  assert.deepEqual(elasticsearch.secrets(make(basic)), { env: ['U', 'P'], files: [], users: ['U'] });
  assert.deepEqual(elasticsearch.secrets(make({ apiKeyEnv: 'K' })), { env: ['K'], files: [] });
  assert.deepEqual(elasticsearch.secrets(make(null)), { env: [], files: [] });
  assert.deepEqual(elasticsearch.open(make({ apiKeyEnv: 'K' }), { secrets: { K: 'fine' } }), { ok: true, extras: {} });
  assert.deepEqual(elasticsearch.open(make({ apiKeyEnv: 'K' }), { secrets: { K: 'a\r\nb' } }), { ok: false, error: 'K holds a character that is not allowed' });
  assert.deepEqual(elasticsearch.open(make(basic), { secrets: { U: 'a:b', P: 'x' } }), { ok: false, error: 'U holds a character that is not allowed' });
  assert.deepEqual(elasticsearch.open(make(null), { secrets: {} }), { ok: true, extras: {} });
  assert.deepEqual(elasticsearch.record({ target: make(basic) }, { reviewed: true }), {
    kind: 'elasticsearch', name: 'e', description: 'logs', allow: ['GET /_cat/...'], baseUrl: 'https://es.internal.example.com:9200/', auth: basic, state: 'up', review: true,
  });
  assert.equal(elasticsearch.record({ target: make(null) }, { reviewed: false }).review, undefined);
  assert.equal(elasticsearch.downMessage(), 'the call service is not answering');
  assert.equal(elasticsearch.backMessage, 'the call service is back');
  assert.deepEqual(elasticsearch.checkInput(['GET', '/x']), { method: 'GET', path: '/x' });
});

test('the agent notes say how a rule is written, that the query is not matched and what is refused', () => {
  const make = (extra = {}) => ({
    kind: 'elasticsearch', name: 'e', baseUrl: 'https://es.internal.example.com:9200/', auth: null, description: 'logs', allow: ['GET /_cat/...'], ...extra,
  });
  const notes = elasticsearch.agentSection(make({ review: true }));
  assert.match(notes, /^### Elasticsearch target `e` - logs\n\n- Tool: `elasticsearch_request` with `target: "e"`\. The user fixed the host/);
  assert.ok(notes.includes('- Allowed requests: GET /_cat/...\n'));
  assert.ok(notes.includes('A rule is the method, then one word per path segment: `GET /_cat/indices` is `GET`, `/_cat`, `/indices`.'));
  assert.ok(notes.includes('`*` matches one path segment, `...` the rest of the path'));
  assert.ok(notes.includes('The query is not checked against the rules.'));
  assert.ok(notes.includes('`_bulk`, `_delete_by_query`, `_update_by_query`, `_reindex`, `_scripts`, `_snapshot`, `_security`, `_ingest`, `_ilm`, `_slm`, `_license` or `_xpack`'));
  assert.ok(notes.includes('DELETE on an index, on `_all` or on a path with a `_data_stream` segment'));
  assert.ok(notes.includes('any method but GET, HEAD or POST on a path that ends in `_search`, `_count` or `_msearch`, any method but GET or HEAD on a path with a `_mapping`, `_mappings` or `_settings` segment anywhere in it'));
  assert.ok(notes.includes('a body with a key whose name holds `script` in any letter case, or a key `runtime_mappings`, `runtime` or `remove_index`'));
  assert.ok(notes.includes('These are refused whatever the rules say, and a reviewer cannot allow them.'));
  assert.ok(notes.includes('the query names `source` and `source_content_type`, which carry a request body'));
  assert.ok(notes.includes('You cannot set headers'));
  assert.ok(notes.includes('The query names `_method`, `x-http-method-override`, `x-method-override` and `x-http-method` are refused in any letter case. A reviewer and the log see the query.'));
  assert.ok(notes.endsWith('- A command that is not on this list is reviewed before it runs and may be refused.'));
  assert.ok(!notes.includes('es.internal.example.com'), 'the host is not in the notes');
  const any = elasticsearch.agentSection(make({ description: '', allow: 'any' }));
  assert.ok(any.startsWith('### Elasticsearch target `e`\n'));
  assert.ok(!any.includes('The query is not checked'));
  assert.ok(!any.includes('reviewed before'));
  assert.ok(any.includes('refused whatever the rules say'));
  assert.equal(elasticsearch.toolBullet, '- `elasticsearch_request { target, method, path, query?, body?, timeout_seconds? }` - send one request to an Elasticsearch target.');
  const def = elasticsearch.tool.definition;
  assert.equal(def.name, TOOL);
  assert.deepEqual(def.inputSchema.required, ['target', 'method', 'path']);
  const session = {
    targets: [{
      kind: 'elasticsearch', name: 'e', description: '', allow: ['GET /_cat/...'], baseUrl: 'https://x.example.com/', auth: null, state: 'up',
    }],
  };
  const text = agentMdText(session);
  assert.ok(text.includes(elasticsearch.toolBullet));
  assert.ok(text.includes('### Elasticsearch target `e`'));
  assert.ok(!agentMdText({ targets: [] }).includes(TOOL));
});

test('tools/list names the tool only when the inventory holds an elasticsearch target', () => {
  const names = (tools) => tools.map((t) => t.name);
  assert.ok(!names(toolDefinitions({ elasticsearch: [] })).includes(TOOL));
  assert.ok(names(toolDefinitions({ elasticsearch: [{}] })).includes(TOOL));
  assert.ok(names(toolDefinitions(null)).includes(TOOL));
});

test('ksproxy check elasticsearch runs the fixed refusals before the rules', async () => {
  const world = await serviceWorld('elasticsearch', {
    targets: [{ name: 'es1', url: service.url, allow: ['* /...', 'GET /_cat/...'] }],
  });
  const check = (...words) => cli(['check', 'es', 'es1', ...words], world.env);
  assert.deepEqual(await check('GET', '/_cat/indices'), { code: 0, stdout: 'ALLOWED by rule: * /...\n', stderr: '' });
  const bulk = await check('POST', '/_bulk');
  assert.equal(bulk.code, 1);
  assert.equal(bulk.stdout, 'REFUSED: _bulk is refused for every elasticsearch target, whatever the rules say.\n');
  assert.equal((await check('DELETE', '/logs')).stdout, 'REFUSED: DELETE on an index is refused for every elasticsearch target, whatever the rules say.\n');
  assert.equal((await check('GET', '//evil')).stdout, 'REFUSED: path may not contain an empty segment: no "//" and no "/" at the end\n');
  const usage = await cli(['--help'], {});
  assert.ok(usage.stdout.includes('[--es x,y]'), usage.stdout);
});

test('a session: every fixed refusal stays away from the service, every audit once, both auth forms on the wire, no secret anywhere', async () => {
  const world = await serviceWorld('elasticsearch', {
    extraEnv: { ES_TEST_USER: USER, ES_TEST_PASSWORD: PASSWORD, ES_TEST_KEY: KEY },
    reviewer: provider,
    targets: [
      {
        name: 'es1', url: service.url, userEnv: 'ES_TEST_USER', passwordEnv: 'ES_TEST_PASSWORD', description: 'basic', allow: [...EXAMPLE, 'GET /echo-headers'],
      },
      { name: 'es2', url: `${service.url}/`, apiKeyEnv: 'ES_TEST_KEY', allow: [...WIDE, 'GET /echo-headers'] },
      {
        name: 'es3', url: service.url, allow: ['GET /echo-headers', 'GET /_cat/...'], review: { reviewer: 'r1', policy: 'read only' },
      },
    ],
  });
  const run = launch(world, { ssh: ['web1'], es: ['es1', 'es2', 'es3'] });
  await ready(run);
  assert.match(run.proc.stderr.text, /es +es1 +OPENING +http:\/\/127\.0\.0\.1:\d+\/prefix\/, basic auth from ES_TEST_USER and ES_TEST_PASSWORD\n/);
  assert.match(run.proc.stderr.text, /es +es2 +OPENING .*API key from ES_TEST_KEY\n/);
  assert.match(run.proc.stderr.text, /es +es3 +REVIEW +reviewer r1/);
  const agentEnv = { ...world.env };
  for (const name of ['ES_TEST_USER', 'ES_TEST_PASSWORD', 'ES_TEST_KEY']) delete agentEnv[name];
  const replies = [];
  const ask = async (args) => {
    const reply = await callTool(TOOL, args, agentEnv);
    replies.push(reply.text);
    return reply;
  };

  const { seen } = service;
  const start = seen.length;
  const health = await ask({ target: 'es1', method: 'GET', path: '/_cluster/health', query: { level: 'QUERY-VALUE-5' } });
  assert.deepEqual(health, {
    text: `exit code: 0\n--- stdout ---\nHTTP 200\ncontent-type: application/json\n\n${JSON.stringify({ method: 'GET', url: '/prefix/_cluster/health?level=QUERY-VALUE-5', body: '' })}`,
    isError: false,
  });
  assert.equal(seen.at(-1).headers.authorization, `Basic ${b64(`${USER}:${PASSWORD}`)}`);
  for (const [path1, rule] of [['/_cat/indices', 'cat'], ['/logs-*/_search', 'star'], ['/logs-1/_mapping', 'mapping']]) {
    const reply = await ask({ target: 'es1', method: 'GET', path: path1 });
    assert.equal(reply.isError, false, `${rule}: ${reply.text}`);
  }
  const search = await ask({ target: 'es1', method: 'POST', path: '/logs-1/_search', body: { query: { match_all: {} } } });
  assert.equal(search.isError, false, search.text);
  assert.equal(seen.at(-1).body, '{"query":{"match_all":{}}}');
  assert.equal(seen.length, start + 5);

  for (const [method, requestPath, body, short] of REFUSALS) {
    const reply = await ask({
      target: 'es2', method, path: requestPath, ...(body === undefined ? {} : { body }),
    });
    assert.equal(reply.isError, true, `${method} ${requestPath}`);
    assert.match(reply.text, /^REFUSED \(elasticsearch es2\): /);
    assert.ok(reply.text.includes('.'), short);
  }
  assert.equal(seen.length, start + 5, 'no refused request reached the service');

  const withKey = await ask({ target: 'es2', method: 'GET', path: '/echo-headers' });
  assert.equal(withKey.isError, false, withKey.text);
  assert.equal(seen.at(-1).headers.authorization, `ApiKey ${KEY}`);
  assert.ok(withKey.text.includes('[hidden]'));
  const echoed = await ask({ target: 'es1', method: 'GET', path: '/echo-headers' });
  assert.ok(echoed.text.includes('[hidden]'));
  const plain = await ask({ target: 'es3', method: 'GET', path: '/echo-headers' });
  assert.equal(plain.isError, false, plain.text);
  assert.equal(seen.at(-1).headers.authorization, undefined);
  assert.equal(seen.at(-1).headers['x-api-key'], undefined);

  const before = seen.length;
  provider.asked.length = 0;
  const bulk = await ask({ target: 'es3', method: 'POST', path: '/_bulk', body: { index: {} } });
  assert.match(bulk.text, /^REFUSED \(elasticsearch es3\): _bulk is refused for every elasticsearch target, whatever the rules say\.$/);
  const gone = await ask({ target: 'es3', method: 'DELETE', path: '/logs' });
  assert.equal(gone.isError, true);
  assert.equal(provider.asked.length, 0, 'a fixed refusal is never sent to the reviewer');
  assert.equal(seen.length, before, 'a reviewer cannot get past a fixed refusal');
  const reviewed = await ask({ target: 'es3', method: 'GET', path: '/_cluster/stats' });
  assert.equal(reviewed.isError, false, reviewed.text);
  assert.equal(provider.asked.length, 1);
  assert.deepEqual(JSON.parse(provider.asked[0].messages[1].content).command, ['GET', '/_cluster', '/stats']);
  assert.equal(seen.length, before + 1);
  const recorded = JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8')).targets;
  assert.deepEqual(recorded.filter((t) => t.kind === 'elasticsearch').map((t) => [t.name, t.auth]), [
    ['es1', { basicUserEnv: 'ES_TEST_USER', basicPasswordEnv: 'ES_TEST_PASSWORD' }],
    ['es2', { apiKeyEnv: 'ES_TEST_KEY' }],
    ['es3', null],
  ]);
  assert.equal(await stopWith(run), 0);

  const calls = auditOf(world).filter((e) => e.event === 'call' && e.tool === TOOL);
  assert.equal(calls.length, 5 + REFUSALS.length + 3 + 2 + 1);
  assert.deepEqual(calls[0].request, {
    method: 'GET', path: '/_cluster/health', query: 'level=QUERY-VALUE-5', body: false,
  });
  const refused = calls.filter((e) => e.decision === 'refused').map((e) => e.short);
  assert.deepEqual(refused.slice(0, REFUSALS.length), REFUSALS.map(([, , , short]) => short));
  assert.equal(calls.at(-1).rule, 'review');
  const audit = fs.readFileSync(world.auditLog, 'utf8');
  assert.ok(!audit.includes('"index"'), 'the body is not in the log');
  for (const text of everythingOf(world, run, replies)) {
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `a secret in: ${text.slice(0, 200)}`);
  }
});

test('a key that could split a header skips the target at open', async () => {
  const world = await serviceWorld('elasticsearch', {
    extraEnv: { ES_TEST_BAD: 'line one\r\nX-Injected: 1' },
    targets: [{ name: 'bad', url: service.url, apiKeyEnv: 'ES_TEST_BAD', allow: ['GET /_cat/...'] }],
  });
  const run = launch(world, { ssh: ['web1'], es: ['bad'] });
  await ready(run);
  assert.match(run.proc.stderr.text, /es +bad +SKIPPED +ES_TEST_BAD holds a character that is not allowed\n/);
  assert.equal(await stopWith(run), 0);
});

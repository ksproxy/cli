import { clip } from '../../text.js';
import { httpServiceKind, plainSegment } from '../engines/http-service.js';

const BANNED = ['_bulk', '_delete_by_query', '_update_by_query', '_reindex', '_scripts', '_snapshot', '_security', '_ingest', '_ilm', '_slm', '_license',
  '_xpack'];
const NODE_ACTIONS = [
  ['shutdown', 'shutting a node down', 'node shutdown refused'],
  ['reload_secure_settings', 'reloading secure settings', 'secure settings reload refused'],
];
const CLUSTER_ACTIONS = [
  ['settings', 'changing cluster settings', 'cluster settings change refused'],
  ['reroute', 'rerouting shards', 'cluster reroute refused'],
];
// The read-only ends, where a search reads with GET, HEAD and POST.
const SEARCH_ENDS = ['_search', '_count', '_msearch'];
// Segments where only GET and HEAD read, wherever they stand in the path: any other method writes the mapping or the
// settings, and Elasticsearch 7 still routes typed and plural forms such as /logs/_mapping/_doc and /logs/_doc/_mappings.
const READ_ONLY_SEGMENTS = ['_mapping', '_mappings', '_settings'];
// A body key is refused when its lower-cased name holds "script", or is one of these: runtime fields run a script,
// and remove_index in an _aliases action deletes an index.
const BODY_KEYS = ['runtime_mappings', 'runtime', 'remove_index'];
// Query names that Elasticsearch reads as the request body and its type, which would skip the body scan and +body.
const BODY_PARAMS = ['source', 'source_content_type'];
const MAX_BODY_DEPTH = 32;

const refused = (what, short) => ({ reason: `${what} is refused for every elasticsearch target, whatever the rules say.`, short });

// Whether a body key is refused: its lower-cased name holds "script", or is one of BODY_KEYS.
function isRefusedKey(name) {
  const lower = name.toLowerCase();
  return lower.includes('script') || BODY_KEYS.includes(lower);
}

// The first refused key found at any depth of a parsed body, or 'deep' when it nests more than MAX_BODY_DEPTH
// levels, or null. Scanned with a list of work to do, so that a deep body costs no stack.
function scanBody(root) {
  const pending = [[root, 1]];
  while (pending.length > 0) {
    const [value, depth] = pending.pop();
    if (value !== null && typeof value === 'object') {
      if (depth > MAX_BODY_DEPTH) return 'deep';
      if (Array.isArray(value)) {
        for (const item of value) pending.push([item, depth + 1]);
      } else {
        for (const [name, item] of Object.entries(value)) {
          if (isRefusedKey(name)) return name;
          pending.push([item, depth + 1]);
        }
      }
    }
  }
  return null;
}

// The segments that name something no rule may allow: a refusal, or null. Compared decoded and in lower case.
function segmentRefusal(method, plain) {
  for (const [i, word] of plain.entries()) {
    const later = plain.slice(i + 1);
    if (BANNED.includes(word)) return refused(word, `${word} refused`);
    if (word === '_nodes') {
      const [, what, short] = NODE_ACTIONS.find(([action]) => later.includes(action)) ?? [];
      if (what !== undefined) return refused(what, short);
    }
    if (word === '_cluster' && method !== 'GET') {
      const [, what, short] = CLUSTER_ACTIONS.find(([action]) => later.includes(action)) ?? [];
      if (what !== undefined) return refused(what, short);
    }
  }
  return null;
}

// The fixed refusals of an elasticsearch request, before any rule: { reason, short }, or null. request is the result
// of readRequest: the method, the segments as written, the query as name and value strings and the body as JSON text.
export function fixedRefusal({
  method, segments, query, body,
}) {
  const plain = segments.map(plainSegment);
  const found = segmentRefusal(method, plain);
  if (found !== null) return found;
  const param = query.map(([name]) => name.toLowerCase()).find((name) => BODY_PARAMS.includes(name));
  if (param !== undefined) return refused(`the query name "${param}"`, 'body in query refused');
  if (method === 'DELETE' && plain[0] === '_all') return refused('DELETE on _all', 'delete of _all refused');
  if (method === 'DELETE' && plain.length <= 1) return refused('DELETE on an index', 'index delete refused');
  if (method === 'DELETE' && plain.includes('_data_stream')) return refused('DELETE on _data_stream', 'data stream delete refused');
  const settings = plain.find((word) => READ_ONLY_SEGMENTS.includes(word));
  if (settings !== undefined && method !== 'GET' && method !== 'HEAD') {
    return refused(`${method} on a path with a ${settings} segment`, 'read-only endpoint');
  }
  const last = plain.at(-1);
  if (SEARCH_ENDS.includes(last) && !['GET', 'HEAD', 'POST'].includes(method)) {
    return refused(`${method} on a path that ends in ${last}`, 'read-only endpoint');
  }
  if (body === undefined) return null;
  const key = scanBody(JSON.parse(body));
  if (key === null) return null;
  if (key === 'deep') return refused(`a body nested more than ${MAX_BODY_DEPTH} levels`, 'body too deep');
  if (key.toLowerCase() === 'remove_index') return refused('a "remove_index" key in the body, which deletes an index,', 'index delete refused');
  return refused(`a "${clip(key, 64)}" key in the body`, 'script in body refused');
}

export default httpServiceKind({
  key: 'elasticsearch',
  flag: 'es',
  label: 'es',
  word: 'elasticsearch',
  noun: 'elasticsearch target',
  countNoun: 'elasticsearch target(s)',
  title: 'Elasticsearch target',
  apiKey: true,
  example: 'GET /_cat/indices',
  sample: [{
    name: 'es-logs',
    url: 'https://es.internal.example.com:9200',
    userEnv: 'ES_USER',
    passwordEnv: 'ES_PASSWORD',
    description: 'logs, read only',
    allow: ['GET /_cluster/health', 'GET /_cat/...', 'GET /logs-*/_search', 'POST /*/_search +body', 'GET /*/_mapping'],
  }],
  doctorPath: '/_cluster/health',
  doctorDescribe: (body) => (typeof body.status === 'string' && /^[a-z]{1,16}$/.test(body.status) ? `cluster ${body.status}` : null),
  toolName: 'elasticsearch_request',
  toolBullet: '- `elasticsearch_request { target, method, path, query?, body?, timeout_seconds? }` - send one request to an Elasticsearch target.',
  toolDescription: 'Send one request to an Elasticsearch target the user opened. The user fixed the host and the credential; give the method and the path, and optionally a query and a JSON body. Each request is checked against the target\'s allowlist and logged.',
  refusedNote: 'Refused: any path with a `_bulk`, `_delete_by_query`, `_update_by_query`, `_reindex`, `_scripts`, `_snapshot`, `_security`, `_ingest`, `_ilm`, `_slm`, `_license` or `_xpack` segment, `_nodes` with `shutdown` or `reload_secure_settings`, `_cluster` with `settings` or `reroute` when the method is not GET, DELETE on an index, on `_all` or on a path with a `_data_stream` segment, any method but GET, HEAD or POST on a path that ends in `_search`, `_count` or `_msearch`, any method but GET or HEAD on a path with a `_mapping`, `_mappings` or `_settings` segment anywhere in it, a body with a key whose name holds `script` in any letter case, or a key `runtime_mappings`, `runtime` or `remove_index`, and the query names `source` and `source_content_type`, which carry a request body.',
  fixedRefusal,
});

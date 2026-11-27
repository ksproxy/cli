// The elasticsearch examples of docs/EXAMPLES.md against Elasticsearch 8.19, one node with security on, over https with
// the CA of the run. es-logs uses an API key that the seed makes at each run, which may read the log indices only;
// search-rw uses the user e2e-search, which may read and update products only (e2e/images/es/start.sh, with the seed
// documents). The node logs every HTTP request that reaches it (HttpTracer), which shows that every allowed request
// reached it and no refused one did.
import { bodyOf, clip, logChecks } from './lib.js';

const REQUEST_LOG = '/eslog/requests.log';

// A request in the node's log: "[id][opaque id][METHOD][/path?query] received request from ...".
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const call = (method, path) => ({
  name: `${method} ${path}`,
  marker: new RegExp(`\\]\\[${method}\\]\\[${escape(path)}(\\?[^\\]]*)?\\] received request`),
});
// The text of an http reply after the status line, the content type and the empty line.
const bodyText = (text) => {
  const at = text.indexOf('--- stdout ---\n');
  const out = at === -1 ? '' : text.slice(at + '--- stdout ---\n'.length);
  return out.slice(out.indexOf('\n\n') + 2);
};

export async function elasticsearchScenario({ checks, agent }) {
  const reached = [];
  const kept = [];
  const send = (target, method, path, { query, body } = {}) => agent.call('elasticsearch_request', {
    target, method, path, ...(query === undefined ? {} : { query }), ...(body === undefined ? {} : { body }),
  });
  const allowed = async (target, method, path, {
    query, body, expect, name = `allowed: ${method} ${path}${body === undefined ? '' : ' +body'}`,
  }) => {
    const answer = await send(target, method, path, { query, body });
    checks.check(name, !answer.isError && answer.text.startsWith('exit code: 0\n--- stdout ---\nHTTP 200') && expect(bodyOf(answer.text), answer.text), clip(answer.text));
    reached.push(call(method, path));
    return answer;
  };
  // A call that ksproxy lets through and the node refuses, because the credential of the target may not do it.
  const forbidden = async (target, method, path, body, why) => {
    const answer = await send(target, method, path, { body });
    checks.check(`the node refuses ${method} ${path}: ${why}`, answer.isError && answer.text.startsWith('exit code: 1\n--- stdout ---\nHTTP 403')
      && bodyOf(answer.text)?.error?.type === 'security_exception', clip(answer.text));
    reached.push(call(method, path));
  };
  // A refusal of ksproxy, with the reason that the docs give for it.
  const refused = async (target, method, path, body, why, reason) => {
    const answer = await send(target, method, path, { body });
    checks.check(`refused: ${method} ${path}${body === undefined ? '' : ' +body'} (${why})`, answer.isError
      && answer.text.startsWith(`REFUSED (elasticsearch ${target}): ${reason}`), clip(answer.text));
    kept.push(call(method, path));
  };
  const total = (body) => body?.hits?.total?.value;
  const cat = { h: 'index,docs.count', s: 'index' };

  checks.begin('elasticsearch: es-logs, read only (an API key that may read logs-*)');
  // The answer of the cluster, not its state: a single node is yellow for a moment while it makes one of its own
  // indices, so green and yellow both count.
  const healthy = (body) => body?.cluster_name === 'e2e' && ['green', 'yellow'].includes(body?.status);
  await allowed('es-logs', 'GET', '/_cluster/health', { expect: healthy });
  await allowed('es-logs', 'GET', '/_cat/indices', {
    query: cat,
    expect: (body, text) => bodyText(text).trim() === 'logs-2026.10 2\nlogs-2026.11 3',
    name: 'allowed: GET /_cat/indices, which lists the log indices only, as the key may see no other',
  });
  await allowed('es-logs', 'GET', '/logs-2026.11/_mapping', {
    expect: (body) => body?.['logs-2026.11']?.mappings?.properties?.level?.type === 'keyword',
  });
  await allowed('es-logs', 'POST', '/logs-2026.11/_search', {
    body: { query: { term: { level: 'error' } } },
    expect: (body) => total(body) === 2 && body.hits.hits.every((hit) => hit._source.level === 'error'),
  });
  await allowed('es-logs', 'POST', '/logs-*/_count', { body: { query: { match_all: {} } }, expect: (body) => body?.count === 5 });
  // "* is one path segment, which can be _all": the key decides which indices a search over _all reads.
  await allowed('es-logs', 'POST', '/_all/_search', {
    body: { size: 0, aggs: { indices: { terms: { field: '_index' } } } },
    expect: (body) => total(body) === 5 && JSON.stringify(body.aggregations.indices.buckets.map((b) => b.key).sort()) === '["logs-2026.10","logs-2026.11"]',
    name: 'allowed: POST /_all/_search +body, which finds the 5 log documents and none of products',
  });
  await forbidden('es-logs', 'POST', '/products/_search', { query: { match_all: {} } }, 'the API key may read logs-* only');
  await forbidden('es-logs', 'POST', '/.security/_search', { query: { match_all: {} } }, 'the rule allows it, and the API key may not read it');
  await refused('es-logs', 'DELETE', '/logs-2026.11', undefined, 'deleting an index is never allowed', 'DELETE on an index is refused for every elasticsearch target');
  await refused('es-logs', 'POST', '/logs-2026.10/_search', {
    query: { match_all: {} }, script_fields: { twice: { script: { source: "doc['level'].value + doc['level'].value" } } },
  }, 'a body key that runs a script is never allowed', 'a "script_fields" key in the body is refused for every elasticsearch target');
  await allowed('es-logs', 'GET', '/_cat/indices', {
    query: cat,
    expect: (body, text) => bodyText(text).includes('logs-2026.11 3'),
    name: 'the refused DELETE changed nothing: logs-2026.11 still holds its 3 documents',
  });

  checks.begin('elasticsearch: search-rw, may update products (the user e2e-search)');
  await allowed('search-rw', 'GET', '/_cluster/health', { expect: healthy });
  await allowed('search-rw', 'GET', '/products/_doc/sku-1042', { expect: (body) => body?._source?.stock === 12 && body?._version === 1 });
  await allowed('search-rw', 'POST', '/products/_update/sku-1042', { body: { doc: { stock: 11 } }, expect: (body) => body?.result === 'updated' });
  await allowed('search-rw', 'GET', '/products/_doc/sku-1042', {
    expect: (body) => body?._source?.stock === 11 && body?._version === 2, name: 'the update set the stock of sku-1042 to 11',
  });
  await allowed('search-rw', 'POST', '/products/_search', {
    body: { query: { match: { name: 'lamp' } } },
    expect: (body) => total(body) === 1 && body.hits.hits[0]._id === 'sku-1042',
  });
  await refused('search-rw', 'POST', '/products/_delete_by_query', { query: { match_all: {} } }, '_delete_by_query is never allowed',
    '_delete_by_query is refused for every elasticsearch target');
  await refused('search-rw', 'POST', '/products/_update/sku-7', { script: { source: 'ctx._source.stock = 0' } },
    'a body key that runs a script is never allowed', 'a "script" key in the body is refused for every elasticsearch target');
  await refused('search-rw', 'DELETE', '/products/_doc/sku-7', undefined, 'no rule allows DELETE', 'not on the allowlist');
  await allowed('search-rw', 'GET', '/products/_doc/sku-7', {
    expect: (body) => body?._source?.stock === 40 && body?._version === 1, name: 'the refused calls changed nothing: sku-7 is still there, stock 40',
  });

  checks.begin('elasticsearch: the request log of the node');
  await logChecks(checks, {
    file: REQUEST_LOG, reached, kept, noun: 'request',
  });
}

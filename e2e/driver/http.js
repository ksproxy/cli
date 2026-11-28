// The http examples of docs/EXAMPLES.md against a stand-in for the Grafana API (e2e/images/grafana/server.js) over
// https on port 443: the http kind needs https for a host that is not the machine itself. The stand-in knows the two
// bearer tokens of the run, viewer and editor, and writes each request to its log with the token's role, never the
// token, so the log shows which requests reached it and which token each one carried.
import { bodyOf, clip, logChecks } from './lib.js';

const REQUEST_LOG = '/httplog/requests.log';
// The role of the token of each target, as the stand-in names it.
const roles = { grafana: 'viewer', 'grafana-notes': 'editor' };

// A request in the stand-in's log: the start of its JSON line.
const call = (target, method, path, query = {}) => ({
  name: `${method} ${path}${Object.keys(query).length === 0 ? '' : `?${new URLSearchParams(query)}`} (${target})`,
  marker: JSON.stringify({
    method, path, query, auth: roles[target],
  }).slice(0, -1),
});

export async function httpScenario({ checks, agent }) {
  const reached = [];
  const kept = [];
  const send = (target, method, path, { query, body } = {}) => agent.call('http_request', {
    target, method, path, ...(query === undefined ? {} : { query }), ...(body === undefined ? {} : { body }),
  });
  const allowed = async (target, method, path, {
    query, body, expect, name = `allowed: ${method} ${path}`,
  }) => {
    const answer = await send(target, method, path, { query, body });
    checks.check(name, !answer.isError && answer.text.startsWith('exit code: 0\n--- stdout ---\nHTTP 200') && expect(bodyOf(answer.text)), clip(answer.text));
    reached.push(call(target, method, path, query));
  };
  // A refusal of ksproxy, with the reason that the docs give for it.
  const refused = async (target, method, path, why) => {
    const answer = await send(target, method, path);
    checks.check(`refused: ${method} ${path} (${why})`, answer.isError
      && answer.text.startsWith(`REFUSED (http ${target}): not on the allowlist`), clip(answer.text));
    kept.push(call(target, method, path));
  };
  const annotationIds = (body) => (Array.isArray(body) ? body.map((a) => a.id) : []);

  checks.begin('http: grafana, read only (viewer token)');
  await allowed('grafana', 'GET', '/api/search', {
    query: { query: 'shop' },
    expect: (body) => JSON.stringify(body?.map((d) => d.uid)) === '["shop-overview","shop-orders"]',
    name: 'allowed: GET /api/search with the query query=shop, which no rule sees',
  });
  await allowed('grafana', 'GET', '/api/dashboards/uid/shop-overview', { expect: (body) => body?.dashboard?.title === 'Shop overview' });
  await allowed('grafana', 'GET', '/api/annotations', { expect: (body) => JSON.stringify(annotationIds(body)) === '[17,18]' });
  await refused('grafana', 'DELETE', '/api/dashboards/uid/shop-overview', 'no rule allows DELETE');
  await allowed('grafana', 'GET', '/api/dashboards/uid/shop-overview', {
    expect: (body) => body?.dashboard?.uid === 'shop-overview', name: 'the refused DELETE changed nothing: the dashboard is still there',
  });

  checks.begin('http: grafana-notes, may add annotations (editor token)');
  await allowed('grafana-notes', 'POST', '/api/annotations', {
    body: {
      dashboardUID: 'shop-overview', time: 1795007200000, text: 'deploy 512', tags: ['deploy'],
    },
    expect: (body) => body?.message === 'Annotation added' && body?.id === 19,
    name: 'allowed: POST /api/annotations +body',
  });
  await allowed('grafana-notes', 'GET', '/api/annotations', {
    query: { dashboardUID: 'shop-overview' },
    expect: (body) => JSON.stringify(annotationIds(body)) === '[17,19]' && body[1].text === 'deploy 512',
    name: 'the new annotation is listed with the dashboard',
  });
  await refused('grafana-notes', 'DELETE', '/api/annotations/17', 'no rule allows DELETE');
  await allowed('grafana-notes', 'GET', '/api/annotations', {
    expect: (body) => annotationIds(body).includes(17), name: 'the refused DELETE changed nothing: annotation 17 is still there',
  });

  checks.begin('http: the request log of the API');
  const text = await logChecks(checks, {
    file: REQUEST_LOG, reached, kept, noun: 'request',
  });
  checks.check('no DELETE reached the API', !text.includes('"method":"DELETE"'), 'a DELETE is in the log');
  // OPTIONS * is the check of the tunnelled plain-http target gf-plain (e2e/driver/tunnels.js), which sends no
  // credential by design.
  const withoutToken = text.split('\n').filter((line) => /"auth":"(none|wrong)"/.test(line) && !line.startsWith('{"method":"OPTIONS",'));
  checks.check('every request carried the token of its target', withoutToken.length === 0, clip(withoutToken.join('\n'), 2000));
}

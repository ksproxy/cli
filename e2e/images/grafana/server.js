// A stand-in for the HTTP API of Grafana, for the http examples of docs/EXAMPLES.md: the paths they name, over https
// on port 443 with the certificate of the run. A request needs one of the two bearer tokens of the run: viewer may
// read, editor may also add and delete annotations and delete dashboards. Every request is written to
// /httplog/requests.log as one JSON line (method, path, query, which token, status, body), never with the token, so
// that the driver can show which calls reached the API. Files in /secrets: server.crt, server.key, viewer_token,
// editor_token. Plain Node, no dependency.
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';

const PORT = 443;
const LOG = '/httplog/requests.log';
const MAX_BODY = 64 * 1024;
const read = (name) => fs.readFileSync(`/secrets/${name}`, 'utf8').trim();
const tokens = { viewer: Buffer.from(read('viewer_token')), editor: Buffer.from(read('editor_token')) };

// The seed, which the driver expects: three dashboards, and the annotations 17 and 18.
const panel = (id, title, type) => ({ id, title, type });
const dashboards = [
  { id: 1, uid: 'shop-overview', title: 'Shop overview', tags: ['shop'], panels: [panel(1, 'Orders per minute', 'timeseries'), panel(2, 'Checkout errors', 'stat')] },
  { id: 2, uid: 'shop-orders', title: 'Shop orders', tags: ['shop', 'orders'], panels: [panel(1, 'Orders by status', 'piechart')] },
  { id: 3, uid: 'infra-nodes', title: 'Infra nodes', tags: ['infra'], panels: [panel(1, 'CPU', 'timeseries')] },
];
const annotations = [
  { id: 17, dashboardUID: 'shop-overview', time: 1795000000000, text: 'deploy 511', tags: ['deploy'] },
  { id: 18, dashboardUID: 'shop-orders', time: 1795003600000, text: 'payment provider slow', tags: ['incident'] },
];
let nextAnnotation = 19;

const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

// The role of the bearer token: viewer, editor, none (no header) or wrong.
function roleOf(header) {
  if (header === undefined) return 'none';
  const given = Buffer.from(header);
  for (const [role, token] of Object.entries(tokens)) {
    const expected = Buffer.from(`Bearer ${token}`);
    if (given.length === expected.length && timingSafeEqual(given, expected)) return role;
  }
  return 'wrong';
}

// One request: { status, body } for the method, the path segments, the query, the role and the parsed body.
function answer(method, segments, query, role, body) {
  const route = segments.join('/');
  const denied = { status: 403, body: { message: 'Permission denied' } };
  if (route === 'api/search') {
    if (method !== 'GET') return { status: 405, body: { message: 'Method not allowed' } };
    const words = (query.get('query') ?? '').toLowerCase();
    return {
      status: 200,
      body: dashboards.filter((d) => d.title.toLowerCase().includes(words)).map((d) => ({
        id: d.id, uid: d.uid, title: d.title, url: `/d/${d.uid}/${slug(d.title)}`, type: 'dash-db', tags: d.tags, isStarred: false,
      })),
    };
  }
  if (segments.length === 4 && route.startsWith('api/dashboards/uid/')) {
    const at = dashboards.findIndex((d) => d.uid === segments[3]);
    if (at === -1) return { status: 404, body: { message: 'Dashboard not found' } };
    const dashboard = dashboards[at];
    if (method === 'GET') {
      return {
        status: 200,
        body: { meta: { type: 'db', slug: slug(dashboard.title), canEdit: role === 'editor' }, dashboard: { ...dashboard, version: 1 } },
      };
    }
    if (method !== 'DELETE') return { status: 405, body: { message: 'Method not allowed' } };
    if (role !== 'editor') return denied;
    dashboards.splice(at, 1);
    return { status: 200, body: { title: dashboard.title, message: `Dashboard ${dashboard.title} deleted`, id: dashboard.id } };
  }
  if (route === 'api/annotations') {
    if (method === 'GET') {
      const uid = query.get('dashboardUID');
      return { status: 200, body: annotations.filter((a) => uid === null || a.dashboardUID === uid) };
    }
    if (method !== 'POST') return { status: 405, body: { message: 'Method not allowed' } };
    if (role !== 'editor') return denied;
    if (body === null || typeof body.text !== 'string') return { status: 400, body: { message: 'text is required' } };
    const id = nextAnnotation;
    nextAnnotation += 1;
    annotations.push({
      id, dashboardUID: body.dashboardUID ?? null, time: body.time ?? Date.now(), text: body.text, tags: body.tags ?? [],
    });
    return { status: 200, body: { message: 'Annotation added', id } };
  }
  if (segments.length === 3 && route.startsWith('api/annotations/')) {
    const at = annotations.findIndex((a) => String(a.id) === segments[2]);
    if (at === -1) return { status: 404, body: { message: 'Annotation not found' } };
    if (method !== 'DELETE') return { status: 405, body: { message: 'Method not allowed' } };
    if (role !== 'editor') return denied;
    annotations.splice(at, 1);
    return { status: 200, body: { message: 'Annotation deleted' } };
  }
  return { status: 404, body: { message: 'Not found' } };
}

const server = https.createServer({ cert: read('server.crt'), key: read('server.key') }, (req, res) => {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size <= MAX_BODY) chunks.push(chunk);
  });
  req.on('end', () => {
    const url = new URL(req.url, 'https://grafana');
    const role = roleOf(req.headers.authorization);
    const text = Buffer.concat(chunks).toString('utf8');
    let body = null;
    let result;
    if (role === 'none' || role === 'wrong') result = { status: 401, body: { message: 'Unauthorized' } };
    if (result === undefined && size > MAX_BODY) result = { status: 413, body: { message: 'the body is too large' } };
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      result ??= { status: 400, body: { message: 'the body is not JSON' } };
    }
    if (result === undefined) {
      result = answer(req.method, url.pathname.split('/').filter(Boolean), url.searchParams, role, body);
    }
    fs.appendFileSync(LOG, `${JSON.stringify({
      method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: role, status: result.status, body,
    })}\n`);
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
  });
});

for (const name of ['SIGTERM', 'SIGINT']) process.on(name, () => process.exit(0));
server.listen(PORT, '0.0.0.0', () => console.log(`grafana stand-in on port ${PORT}`));

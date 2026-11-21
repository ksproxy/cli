import { httpServiceKind, plainSegment } from '../engines/http-service.js';

const ADMIN_AREAS = [
  'users', 'permissions', 'topic-permissions', 'user-limits', 'vhost-limits', 'parameters', 'global-parameters', 'policies',
  'operator-policies', 'vhosts', 'auth', 'reset',
];
const READ_METHODS = ['GET', 'HEAD'];

const refused = (what, short) => ({ reason: `${what} is refused for every rabbitmq target, whatever the rules say.`, short });

// The fixed refusals of a rabbitmq request, before any rule: { reason, short }, or null. Segments are compared decoded
// and in lower case. Only the management API is spoken: every path starts with the segment api.
export function fixedRefusal({ method, segments }) {
  const plain = segments.map(plainSegment);
  const [first, area] = plain;
  const last = plain.at(-1);
  if (first !== 'api') return refused('a path that does not start with /api', 'not an api path');
  if (area === 'definitions' && method !== 'GET') return refused(`${method} on /api/definitions`, 'definitions write refused');
  if (ADMIN_AREAS.includes(area) && !READ_METHODS.includes(method)) return refused(`${method} on /api/${area}`, 'admin write refused');
  if (area === 'queues' && last === 'get') return refused('taking messages off a queue', 'queue get refused');
  if (area === 'queues' && last === 'contents' && method === 'DELETE') return refused('purging a queue', 'queue purge refused');
  if (area === 'exchanges' && last === 'publish') return refused('publishing a message', 'publish refused');
  return null;
}

export default httpServiceKind({
  key: 'rabbitmq',
  flag: 'mq',
  label: 'mq',
  word: 'rabbitmq',
  noun: 'rabbitmq target',
  countNoun: 'rabbitmq target(s)',
  title: 'RabbitMQ target',
  apiKey: false,
  example: 'GET /api/queues',
  sample: [{
    name: 'mq-prod',
    url: 'https://mq.internal.example.com:15671',
    userEnv: 'MQ_USER',
    passwordEnv: 'MQ_PASSWORD',
    description: 'management API, read only',
    allow: ['GET /api/overview', 'GET /api/queues/...', 'GET /api/exchanges/...', 'GET /api/nodes'],
  }],
  toolName: 'rabbitmq_request',
  toolBullet: '- `rabbitmq_request { target, method, path, query?, body?, timeout_seconds? }` - send one request to the management API of a RabbitMQ target.',
  toolDescription: 'Send one request to the management HTTP API of a RabbitMQ target the user opened. The user fixed the host and the credential; give the method and the path, and optionally a query and a JSON body. Each request is checked against the target\'s allowlist and logged.',
  refusedNote: 'Only the management HTTP API is spoken: every path must start with `/api`. Refused: any method but GET or HEAD on users, permissions, topic-permissions, user-limits, vhost-limits, parameters, global-parameters, policies, operator-policies, vhosts, auth and reset, any method but GET on definitions, taking messages off a queue (a path under queues that ends in get), purging a queue (DELETE on a path under queues that ends in contents) and publishing (a path under exchanges that ends in publish).',
  vhostSegment: true,
  vhostNote: 'The default virtual host `/` is written as the one path segment `%2F`, for example `GET /api/queues/%2F/orders`; a rule names it as `%2F` too, and `*` and `...` match it. No other encoded slash is accepted.',
  fixedRefusal,
});

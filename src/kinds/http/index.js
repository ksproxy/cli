import {
  decide, describeAllow, isRegexRule,
} from '../../allowlist.js';
import {
  InventoryError, checkAllow, checkKeys, checkReview, checkSecretVariable, isObject,
} from '../../checks.js';
import { hostAnswers } from './reach.js';
import { clip } from '../../text.js';
import { REVIEWED } from '../shared.js';
import {
  BODY_WORD, METHODS, PAGING_HINT, authHeader, authProblem, authSecrets, encodedForms, headerNameProblem,
  matchRequestRule, readRequest, requestWords, reviewWords, send, splitRule, validateBaseUrl,
} from '../engines/http.js';

const HTTP_KEYS = ['name', 'baseUrl', 'auth', 'description', 'allow', 'review'];
const AUTH_FORMS = [['bearerEnv'], ['basicUserEnv', 'basicPasswordEnv'], ['headerName', 'headerEnv']];
const HOLDS = {
  bearerEnv: 'the token', basicUserEnv: 'the user name', basicPasswordEnv: 'the password', headerEnv: 'the header value',
};
const NOT_FOR_REVIEW = 'a request with a body is not sent to the reviewer, who cannot see the body';
const MAX_AUDITED_QUERY = 1024;
const QUERY_TYPES = ['string', 'number', 'boolean'];
// The note on the query for the agent, shared with the kinds built by httpServiceKind.
export const QUERY_NOTE = 'The query names `_method`, `x-http-method-override`, `x-method-override` and `x-http-method` are refused in any letter case. A reviewer and the log see the query.';

const sameKeys = (form, keys) => form.length === keys.length && form.every((key) => keys.includes(key));

// The auth of a target in one of its three forms, with the keys in a fixed order, or null without auth.
function checkAuth(auth, where) {
  if (auth === undefined) return null;
  const at = `${where}: auth`;
  const form = isObject(auth) ? AUTH_FORMS.find((f) => sameKeys(f, Object.keys(auth))) : undefined;
  if (form === undefined) {
    throw new InventoryError(`${at}: must be {"bearerEnv": NAME}, {"basicUserEnv": NAME, "basicPasswordEnv": NAME} or {"headerName": HEADER, "headerEnv": NAME}`);
  }
  if (form[0] === 'headerName') {
    const problem = headerNameProblem(auth.headerName);
    if (problem !== null) throw new InventoryError(`${at}.headerName: ${problem}`);
  }
  for (const key of form.filter((k) => k.endsWith('Env'))) checkSecretVariable(auth[key], `${at}.${key}`, HOLDS[key]);
  return Object.fromEntries(form.map((key) => [key, auth[key]]));
}

// A word rule of an http target is a request line: METHOD /path, or METHOD /path +body.
function checkRules(allow, where) {
  if (!Array.isArray(allow)) return;
  allow.forEach((rule, i) => {
    if (!isRegexRule(rule) && splitRule(rule) === null) {
      throw new InventoryError(`${where}: allow[${i}]: an http rule is a method and a path, for example GET /api/search, and may end in +body to allow a JSON body`);
    }
  });
}

function authText(auth) {
  if (auth === null) return 'no auth';
  if (auth.bearerEnv !== undefined) return `bearer token from ${auth.bearerEnv}`;
  if (auth.basicUserEnv !== undefined) return `basic auth from ${auth.basicUserEnv} and ${auth.basicPasswordEnv}`;
  return `header ${auth.headerName} from ${auth.headerEnv}`;
}

// The query as the audit entry keeps it: encoded as it would be sent, a value of another type as (invalid), clipped.
function auditedQuery(query) {
  if (!isObject(query)) return '(invalid)';
  const pairs = Object.entries(query).map(([name, value]) => [name, QUERY_TYPES.includes(typeof value) ? String(value) : '(invalid)']);
  return clip(new URLSearchParams(pairs).toString(), MAX_AUDITED_QUERY);
}

// The custom http kind: a target the user defines in the inventory, brokered by ksproxy start, which holds the
// credential and sends the request through the http engine.
export default {
  key: 'http',
  flag: 'http',
  label: 'http',
  word: 'http',
  noun: 'http target',
  countNoun: 'http target(s)',
  brokered: true,
  sample: [{
    name: 'grafana',
    baseUrl: 'https://grafana.example.com',
    auth: { bearerEnv: 'GRAFANA_TOKEN' },
    description: 'dashboards, read only',
    allow: ['GET /api/search', 'GET /api/dashboards/uid/*'],
  }],
  hint(target) {
    const { host } = new URL(target.baseUrl);
    return target.description ? `${host} - ${target.description}` : host;
  },
  validate(entry, where, { reviewers }) {
    checkKeys(entry, HTTP_KEYS, where);
    const baseUrl = validateBaseUrl(entry.baseUrl, `${where}: baseUrl`);
    const auth = checkAuth(entry.auth, where);
    const allow = checkAllow(entry, where);
    checkRules(allow, where);
    return {
      kind: 'http',
      name: entry.name,
      baseUrl,
      auth,
      description: entry.description ?? '',
      allow,
      ...checkReview(entry, where, reviewers, allow, { programs: false }),
    };
  },
  secrets(target) {
    return authSecrets(target.auth);
  },
  openingMessage(target) {
    return `${target.baseUrl}, ${authText(target.auth)}`;
  },
  open(target, { secrets }) {
    const problem = authProblem(target.auth, secrets);
    return problem === null ? { ok: true, extras: {} } : { ok: false, error: problem };
  },
  // The check of ksproxy doctor: the host answers on its port. No HTTP request is sent.
  doctor(opened, { timeoutMs, signal }) {
    return hostAnswers(new URL(opened.target.baseUrl), { timeoutMs, signal });
  },
  record(opened, { reviewed }) {
    const { target } = opened;
    return {
      kind: 'http',
      name: target.name,
      description: target.description,
      allow: target.allow,
      baseUrl: target.baseUrl,
      auth: target.auth,
      state: 'up',
      ...(reviewed ? { review: true } : {}),
    };
  },
  downMessage() {
    return 'the call service is not answering';
  },
  backMessage: 'the call service is back',
  decide(target, input) {
    let request;
    try {
      request = readRequest(input);
    } catch (err) {
      return { allowed: false, reason: err.message, short: err.short };
    }
    const decision = decide(requestWords(request), target.allow, matchRequestRule);
    const argv = reviewWords(request);
    if (decision.allowed || request.body === undefined) return { ...decision, argv };
    return { ...decision, argv, notReviewed: NOT_FOR_REVIEW };
  },
  async perform(target, decision, {
    secrets, timeoutMs, maxBytes, signal, input,
  }) {
    const request = readRequest(input);
    return send({
      baseUrl: target.baseUrl, headers: authHeader(target.auth, secrets), ...request, timeoutMs, maxBytes, signal,
    });
  },
  // The base64 credential of basic auth and the secrets as a JSON body shows them, which the core hides with the values.
  hiddenForms(target, secrets) {
    return encodedForms(target.auth, secrets);
  },
  // ksproxy check http NAME METHOD PATH [+body]: the words as the request the tool would get.
  checkInput(words) {
    const [method, path, ...more] = words;
    if (more.length === 0) return { method, path };
    const rest = more.join(' ');
    return { method, path, body: rest === BODY_WORD ? {} : rest };
  },
  toolBullet: '- `http_request { target, method, path, query?, body?, timeout_seconds? }` - send one HTTP request to an http target.',
  cutHint: PAGING_HINT,
  agentSection(target) {
    const lines = [
      `### http target \`${target.name}\`${target.description ? ` - ${target.description}` : ''}`,
      '',
      `- Tool: \`http_request\` with \`target: "${target.name}"\`. The user fixed the host; give the method, the path from "/", and optionally a query object and a JSON body.`,
      `- Allowed requests: ${describeAllow(target.allow)}`,
    ];
    if (target.allow !== 'any') {
      lines.push('- A rule is a method and a path. `*` matches one path segment, `...` the rest of the path, and a rule that ends in `+body` allows, and needs, a JSON body. The query is not checked against the rules.');
    }
    lines.push(`- You cannot set headers, and redirects are not followed. ${QUERY_NOTE} The reply is the status, the content type and the body as text.`);
    if (target.review) lines.push(REVIEWED);
    return lines.join('\n');
  },
  tool: {
    name: 'http_request',
    nameKey: 'target',
    detailKey: 'request',
    detailIsArray: false,
    detailShape: 'object',
    // The request as the audit entry records it: the method, the path, the query when one was given, and whether a
    // body was sent. Never the body or a header.
    auditedDetail(detail) {
      return {
        method: typeof detail.method === 'string' ? clip(detail.method, 16) : null,
        path: typeof detail.path === 'string' ? clip(detail.path, 512) : null,
        ...(detail.query === undefined ? {} : { query: auditedQuery(detail.query) }),
        body: detail.body !== undefined,
      };
    },
    detailText(recorded) {
      if (typeof recorded.method !== 'string' || typeof recorded.path !== 'string') return '(invalid)';
      const query = typeof recorded.query === 'string' && recorded.query !== '' ? `?${recorded.query}` : '';
      return `${recorded.method} ${recorded.path}${query}${recorded.body === true ? ` ${BODY_WORD}` : ''}`;
    },
    definition: {
      name: 'http_request',
      description: 'Send one HTTP request to an http target the user opened. The user fixed the host and the credential; give the method and the path, and optionally a query and a JSON body. Each request is checked against the target\'s allowlist and logged.',
      inputSchema: {
        type: 'object',
        required: ['target', 'method', 'path'],
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'Target name from list_targets' },
          method: { type: 'string', enum: METHODS },
          path: { type: 'string', description: 'The path under the target\'s base URL, starting with "/", without a query or fragment' },
          query: {
            type: 'object',
            description: 'Query parameters, each a string, a number or true or false',
            additionalProperties: { type: ['string', 'number', 'boolean'] },
          },
          body: { type: ['object', 'array'], description: 'A JSON body, only for a request that a rule ending in +body allows' },
          timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, default: 60 },
        },
      },
    },
  },
};

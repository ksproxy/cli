import { decide, describeAllow, isRegexRule } from '../../allowlist.js';
import {
  InventoryError, checkAllow, checkKeys, checkReview, checkSecretVariable,
} from '../../checks.js';
import { REVIEWED } from '../shared.js';
import { DOCTOR_MAX_BYTES, hiddenOf, httpVerdict } from './doctor.js';
import httpKind, { QUERY_NOTE } from '../http/index.js';
import {
  PAGING_HINT, authHeader, authProblem, authSecrets, encodedForms, matchRequestRule, readRequest, requestWords,
  reviewWords, send, splitRule, validateBaseUrl,
} from './http.js';

// The shape that two brokered kinds on the http engine share: elasticsearch and rabbitmq. A kind gives its names, its
// sample, its notes and its fixed refusals; this file gives the inventory checks for url and the auth fields, the
// session, the decision and the one request. The fixed refusals run before any rule.

const NOT_FOR_REVIEW = 'a request with a body is not sent to the reviewer, who cannot see the body';
const PERCENT = /%([0-9A-Fa-f]{2})/g;

// A path segment as a fixed refusal compares it: percent-encodings decoded, lower case.
export const plainSegment = (segment) => segment
  .replace(PERCENT, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
  .toLowerCase();

// The auth of an entry: basic from userEnv and passwordEnv, an API key from apiKeyEnv, or null. Both forms is an error.
function readAuth(entry, where) {
  const user = entry.userEnv !== undefined;
  const password = entry.passwordEnv !== undefined;
  const apiKey = entry.apiKeyEnv !== undefined;
  if (apiKey && (user || password)) {
    throw new InventoryError(`${where}: give userEnv and passwordEnv, or apiKeyEnv, not both`);
  }
  if (user !== password) throw new InventoryError(`${where}: userEnv and passwordEnv must be given together`);
  if (apiKey) return { apiKeyEnv: checkSecretVariable(entry.apiKeyEnv, `${where}: apiKeyEnv`, 'the API key') };
  if (!user) return null;
  return {
    basicUserEnv: checkSecretVariable(entry.userEnv, `${where}: userEnv`, 'the user name'),
    basicPasswordEnv: checkSecretVariable(entry.passwordEnv, `${where}: passwordEnv`, 'the password'),
  };
}

// The auth as the engine's helpers know it: an API key is a header form with one value that must be printable ASCII.
const engineAuth = (auth) => (auth !== null && auth.apiKeyEnv !== undefined
  ? { headerName: 'x-api-key', headerEnv: auth.apiKeyEnv }
  : auth);


function headersOf(auth, secrets) {
  if (auth !== null && auth.apiKeyEnv !== undefined) return { authorization: `ApiKey ${secrets[auth.apiKeyEnv]}` };
  return authHeader(auth, secrets);
}

function authText(auth) {
  if (auth === null) return 'no auth';
  if (auth.apiKeyEnv !== undefined) return `API key from ${auth.apiKeyEnv}`;
  return `basic auth from ${auth.basicUserEnv} and ${auth.basicPasswordEnv}`;
}

// A word rule is a request line: METHOD /path, or METHOD /path +body.
function checkRules(allow, where, example, pathOptions) {
  if (!Array.isArray(allow)) return;
  allow.forEach((rule, i) => {
    if (!isRegexRule(rule) && splitRule(rule, pathOptions) === null) {
      throw new InventoryError(`${where}: allow[${i}]: a rule is a method and a path, for example ${example}, and may end in +body to allow a JSON body`);
    }
  });
}

// spec: key, flag, label, word, noun, countNoun, apiKey (whether apiKeyEnv is a field), sample, example (a rule),
// toolName, toolDescription, toolBullet, title, refusedNote (one sentence for the notes), fixedRefusal(request),
// doctorPath and doctorDescribe (the fixed GET of the doctor check and the detail of its JSON answer, or null),
// vhostSegment (whether a path segment may be exactly %2F, for RabbitMQ's default virtual host) with vhostNote.
export function httpServiceKind(spec) {
  const keys = ['name', 'url', 'userEnv', 'passwordEnv', ...(spec.apiKey ? ['apiKeyEnv'] : []), 'description', 'allow', 'review'];
  const pathOptions = { vhostSegment: spec.vhostSegment === true };
  const matchKindRule = (words, rule) => matchRequestRule(words, rule, pathOptions);
  return {
    key: spec.key,
    flag: spec.flag,
    label: spec.label,
    word: spec.word,
    noun: spec.noun,
    countNoun: spec.countNoun,
    brokered: true,
    sample: spec.sample,
    hint(target) {
      const { host } = new URL(target.baseUrl);
      return target.description ? `${host} - ${target.description}` : host;
    },
    validate(entry, where, { reviewers }) {
      checkKeys(entry, keys, where);
      const baseUrl = validateBaseUrl(entry.url, `${where}: url`);
      const auth = readAuth(entry, where);
      const allow = checkAllow(entry, where);
      checkRules(allow, where, spec.example, pathOptions);
      return {
        kind: spec.key,
        name: entry.name,
        baseUrl,
        auth,
        description: entry.description ?? '',
        allow,
        ...checkReview(entry, where, reviewers, allow, { programs: false }),
      };
    },
    secrets(target) {
      return authSecrets(engineAuth(target.auth));
    },
    openingMessage(target) {
      return `${target.baseUrl}, ${authText(target.auth)}`;
    },
    open(target, { secrets }) {
      const problem = authProblem(engineAuth(target.auth), secrets);
      return problem === null ? { ok: true, extras: {} } : { ok: false, error: problem };
    },
    record(opened, { reviewed }) {
      const { target } = opened;
      return {
        kind: spec.key,
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
        request = readRequest(input, pathOptions);
      } catch (err) {
        return { allowed: false, reason: err.message, short: err.short };
      }
      const fixed = spec.fixedRefusal(request);
      if (fixed !== null) return { allowed: false, reason: fixed.reason, short: fixed.short };
      const decision = decide(requestWords(request), target.allow, matchKindRule);
      const argv = reviewWords(request);
      if (decision.allowed || request.body === undefined) return { ...decision, argv };
      return { ...decision, argv, notReviewed: NOT_FOR_REVIEW };
    },
    async perform(target, decision, {
      secrets, timeoutMs, maxBytes, signal, input,
    }) {
      const request = readRequest(input, pathOptions);
      return send({
        baseUrl: target.baseUrl, headers: headersOf(target.auth, secrets), ...request, timeoutMs, maxBytes, signal,
      });
    },
    // The base64 credential of basic auth and the secrets as a JSON body shows them, which the core hides with the values.
    hiddenForms(target, secrets) {
      return encodedForms(engineAuth(target.auth), secrets);
    },
    // The doctor check: the one fixed GET of the spec through the same send, never a rule of the agent.
    async doctor(opened, { secrets, timeoutMs, signal }) {
      const { target } = opened;
      const request = readRequest({ method: 'GET', path: spec.doctorPath }, pathOptions);
      const result = await send({
        baseUrl: target.baseUrl, headers: headersOf(target.auth, secrets), ...request, timeoutMs, maxBytes: DOCTOR_MAX_BYTES, signal,
      });
      return httpVerdict(result, {
        request: `GET ${spec.doctorPath}`,
        describe: spec.doctorDescribe,
        hidden: hiddenOf(secrets, encodedForms(engineAuth(target.auth), secrets)),
        signal,
      });
    },
    checkInput: httpKind.checkInput,
    toolBullet: spec.toolBullet,
    cutHint: PAGING_HINT,
    agentSection(target) {
      const lines = [
        `### ${spec.title} \`${target.name}\`${target.description ? ` - ${target.description}` : ''}`,
        '',
        `- Tool: \`${spec.toolName}\` with \`target: "${target.name}"\`. The user fixed the host; give the method, the path from "/", and optionally a query object and a JSON body.`,
        `- Allowed requests: ${describeAllow(target.allow)}`,
      ];
      if (target.allow !== 'any') {
        const [method, path] = spec.example.split(' ');
        const split = [method, ...path.slice(1).split('/').map((segment) => `/${segment}`)].map((word) => `\`${word}\``).join(', ');
        lines.push(`- A rule is the method, then one word per path segment: \`${spec.example}\` is ${split}. \`*\` matches one path segment, \`...\` the rest of the path, and a rule that ends in \`+body\` allows, and needs, a JSON body. The query is not checked against the rules.`);
      }
      if (pathOptions.vhostSegment) lines.push(`- ${spec.vhostNote}`);
      lines.push(`- ${spec.refusedNote} These are refused whatever the rules say, and a reviewer cannot allow them.`);
      lines.push(`- You cannot set headers, and redirects are not followed. ${QUERY_NOTE} The reply is the status, the content type and the body as text.`);
      if (target.review) lines.push(REVIEWED);
      return lines.join('\n');
    },
    tool: {
      name: spec.toolName,
      nameKey: 'target',
      detailKey: 'request',
      detailIsArray: false,
      detailShape: 'object',
      auditedDetail: httpKind.tool.auditedDetail,
      detailText: httpKind.tool.detailText,
      definition: {
        name: spec.toolName,
        description: spec.toolDescription,
        inputSchema: httpKind.tool.definition.inputSchema,
      },
    },
  };
}

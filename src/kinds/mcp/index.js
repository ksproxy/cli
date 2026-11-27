import fs from 'node:fs';
import path from 'node:path';
import {
  InventoryError, checkInteger, checkKeys, checkSecretVariable, isObject,
} from '../../checks.js';
import { minimalEnv } from '../../exec.js';
import { processStartTime } from '../../session.js';
import { clip } from '../../text.js';
import { jsonBodyForms } from '../shared.js';
import { LOADER_PREFIXES, checkProgram, resolveProgram } from '../command/index.js';
import { workRoot } from '../engines/command.js';
import {
  authHeader, authProblem, authSecrets, encodedForms, hideSecrets,
} from '../engines/http.js';
import {
  MAX_LIST_BYTES, MAX_MESSAGE_BYTES, MAX_TOOLS, connectHttp, connectStdio, dropCut,
} from '../engines/mcp-client.js';
import { answerOf, endText } from './answer.js';
import {
  TOOLS_FILE, exportTools, indexTools, isDuplicate, toolsFileText,
} from './export.js';
import { pinProblem } from './pin.js';
import {
  allowingRule, checkMcpAllow, checkPinned, decideCall, describeRules, readCall, regexWarnings, sortedJson,
} from './rules.js';

// The mcp kind: an MCP server that ksproxy start runs (command, over stdio) or reaches (url, over HTTP) with the
// credential it holds. open starts it, lists its tools and keeps the live client in the opened entry; perform calls one
// tool through it. The agent sees the allowed tools as TARGET__TOOL, from mcp-tools.json; the fixed tool mcp_call is
// never listed but answers when called. The server's stderr never reaches the audit log: its last lines go to the
// terminal through ctx.say, every secret of the target hidden first.

const MCP_KEYS = ['name', 'description', 'allow', 'review', 'command', 'env', 'url', 'login', 'tokenEnv', 'userEnv', 'arguments', 'timeoutSeconds'];
const REMOTE_KEYS = ['login', 'tokenEnv', 'userEnv'];
const LOGINS = ['none', 'token', 'basic'];
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SECRET_LIKE = /TOKEN|PASSWORD|PASSWD|SECRET|KEY/i;
// A query name of a url that looks like a secret; a command word that holds a URL with a user and a password; an option
// of a command that looks like it gives a secret, its name before any =VALUE.
const SECRET_QUERY = /key|token|secret|password|passwd|auth|sig/i;
const USER_AND_PASSWORD = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#@\s]*:[^/?#@\s]*@/;
const SECRET_OPTION = /^-[^=]*(?:token|passw(?:or)?d|secret|api[-_]?key)/i;
// A word, or the value of an option after its =, that sets a variable to a value (NAME=VALUE, as docker run -e takes it)
// or is a header line (NAME: VALUE, as --header takes it); each is told when its name looks like a secret.
const SETTING = /^([A-Za-z_][A-Za-z0-9_]*)=./;
const HEADER = /^([A-Za-z0-9-]+)\s*:\s*\S/;
const SECRET_HEADER = /auth|token|secret|key|passw(?:or)?d/i;
const WHOLE_COMMAND = 'the command is written whole to session.json and shown on the OPENING line, so put the secret in env with {"fromEnv": NAME}';
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_WORDS = 50;
const MAX_WORD_BYTES = 1024;
const MAX_ENV = 50;
const MAX_VALUE_BYTES = 4096;
const CACHE_VARIABLES = ['XDG_CACHE_HOME', 'UV_CACHE_DIR', 'npm_config_cache'];
const TAIL_LINES = 20;
const TAIL_CHARS = 500;
const FOLDER_PREFIX = 'mcp-';
const FAILED = 'the MCP server failed; its last lines are in the start terminal';
const UNREACHED = 'the MCP server could not be reached; the reason is in the start terminal';
const STOPPED = 'the start of the MCP server was stopped';
const NO_FOLDER = 'could not make the private folder of the MCP server';
const NO_PING = 'the MCP server did not answer a ping';

// The time limits, the line limit and the limit of all the pages of tools/list. Tests may lower them.
export const limits = {
  startMs: 120000, connectMs: 30000, probeMs: 10000, pingEveryMs: 300000, maxMessageBytes: MAX_MESSAGE_BYTES, maxListBytes: MAX_LIST_BYTES,
};

// How a target reaches its server: stdio for command, http for url. Tests may replace either.
export const connectors = { stdio: connectStdio, http: connectHttp };

// The command of a local server: the program, checked as the command kind checks its program, then its words. A
// runner that downloads a package must pin it.
function checkCommand(value, where) {
  const ok = Array.isArray(value) && value.length >= 1 && value.length <= MAX_WORDS
    && value.every((word) => typeof word === 'string' && Buffer.byteLength(word) <= MAX_WORD_BYTES && !CONTROL.test(word));
  if (!ok) {
    throw new InventoryError(`${where}: command: must be a list of 1 to ${MAX_WORDS} words, the program and its arguments, each at most ${MAX_WORD_BYTES} bytes and without control characters`);
  }
  const argv = [checkProgram(value[0], `${where}: command[0]`), ...value.slice(1)];
  const problem = pinProblem(argv);
  if (problem !== null) throw new InventoryError(`${where}: command: ${problem}`);
  return argv;
}

// The variables of a local server: each a plain text, or {"fromEnv": NAME}, a variable of start read as a secret.
function checkServerEnv(value, where) {
  if (value === undefined) return {};
  if (!isObject(value) || Object.keys(value).length > MAX_ENV) {
    throw new InventoryError(`${where}: env: must be an object of at most ${MAX_ENV} variables, each a text or {"fromEnv": NAME}`);
  }
  return Object.fromEntries(Object.entries(value).map(([name, source]) => {
    const at = `${where}: env[${JSON.stringify(clip(name, 64))}]`;
    if (!VARIABLE.test(name)) throw new InventoryError(`${at}: must be the name of an environment variable: letters, digits and "_", not starting with a digit`);
    if (LOADER_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      throw new InventoryError(`${at}: ${name} changes how programs are loaded; name another variable`);
    }
    if (typeof source === 'string') {
      if (Buffer.byteLength(source) > MAX_VALUE_BYTES || CONTROL.test(source)) {
        throw new InventoryError(`${at}: a text value is at most ${MAX_VALUE_BYTES} bytes, without control characters`);
      }
      return [name, source];
    }
    if (!isObject(source) || Object.keys(source).length !== 1 || !Object.hasOwn(source, 'fromEnv')) {
      throw new InventoryError(`${at}: must be a text or {"fromEnv": NAME}`);
    }
    return [name, { fromEnv: checkSecretVariable(source.fromEnv, `${at}.fromEnv`) }];
  }));
}

// The URL of a remote server: https, or http on a loopback name; no user, password or fragment; a query is allowed.
function checkUrl(value, where) {
  let url = null;
  try {
    url = new URL(value);
  } catch {
    // not a URL
  }
  if (url === null) throw new InventoryError(`${where}: url: must be a URL`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname))) {
    throw new InventoryError(`${where}: url: must use https (http is accepted for localhost only)`);
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new InventoryError(`${where}: url: must not contain a user name, a password or a fragment`);
  }
  return url.href;
}

// The login of a remote server: none, token (tokenEnv, sent as a bearer token) or basic (userEnv and tokenEnv).
function checkLogin(entry, where) {
  const login = entry.login ?? 'none';
  if (!LOGINS.includes(login)) throw new InventoryError(`${where}: login: must be "none", "token" or "basic"`);
  const tokenEnv = entry.tokenEnv === undefined ? null : checkSecretVariable(entry.tokenEnv, `${where}: tokenEnv`, 'the token');
  const userEnv = entry.userEnv === undefined ? null : checkSecretVariable(entry.userEnv, `${where}: userEnv`, 'the user name');
  if (login !== 'none' && tokenEnv === null) throw new InventoryError(`${where}: login "${login}" needs tokenEnv`);
  if (login === 'none' && tokenEnv !== null) throw new InventoryError(`${where}: tokenEnv needs login "token" or "basic"`);
  if ((login === 'basic') !== (userEnv !== null)) throw new InventoryError(`${where}: userEnv goes with login "basic", and login "basic" needs it`);
  return { login, tokenEnv, userEnv };
}

// The auth of a remote target as the http engine knows it.
function engineAuth(target) {
  if (target.login === 'token') return { bearerEnv: target.tokenEnv };
  if (target.login === 'basic') return { basicUserEnv: target.userEnv, basicPasswordEnv: target.tokenEnv };
  return null;
}

const commandText = (command) => [path.basename(command[0]), ...command.slice(1)].join(' ');

function serverText(target) {
  return target.url === undefined ? clip(commandText(target.command), 80) : new URL(target.url).host;
}

function loginText(target) {
  if (target.login === 'token') return `token from ${target.tokenEnv}`;
  if (target.login === 'basic') return `basic auth from ${target.userEnv} and ${target.tokenEnv}`;
  return 'no login';
}

// The whole environment of a local server: PATH, HOME, LANG, LC_ALL and TMPDIR of start, the cache folders of uv and
// npm when start has them, then the target's env, each {"fromEnv"} value from the target's secrets. Nothing else.
export function serverEnv(target, env, secrets) {
  const caches = CACHE_VARIABLES.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]);
  const own = Object.entries(target.env).map(([name, value]) => [name, typeof value === 'string' ? value : secrets[value.fromEnv]]);
  return minimalEnv(env, Object.fromEntries([...caches, ...own]), { own: false });
}

// The base64 credential of a remote server with basic auth, and each secret value written inside a JSON text, where
// it differs from the value: a server may echo it that way.
function hiddenForms(target, secrets) {
  return target.url === undefined ? jsonBodyForms(Object.values(secrets)) : encodedForms(engineAuth(target), secrets);
}

const hiddenOf = (target, secrets) => [...Object.values(secrets), ...hiddenForms(target, secrets)];

// The warnings of a url whose query names look like a secret: each by its index, never its name or value.
function urlWarnings(url) {
  return [...new URL(url).searchParams.keys()].flatMap((name, i) => (SECRET_QUERY.test(name)
    ? [`url.query[${i}]: its name looks like a secret; the url is written whole to session.json, so give the secret through login "token" or "basic" with tokenEnv, which start holds and hides`]
    : []));
}

// The warnings of a command whose words seem to hold a secret: each by its index, never the word.
function commandWarnings(command) {
  return command.flatMap((word, i) => {
    if (USER_AND_PASSWORD.test(word)) return [`command[${i}]: holds a URL with a user name and a password; ${WHOLE_COMMAND}`];
    if (SECRET_OPTION.test(word)) return [`command[${i}]: looks like an option that gives a secret; ${WHOLE_COMMAND}`];
    const value = word.startsWith('-') ? word.slice(word.indexOf('=') + 1) : word;
    if (SECRET_HEADER.test(HEADER.exec(value)?.[1] ?? '')) return [`command[${i}]: looks like a header that gives a secret; ${WHOLE_COMMAND}`];
    if (SECRET_LIKE.test(SETTING.exec(value)?.[1] ?? '')) return [`command[${i}]: sets a variable whose name looks like a secret; ${WHOLE_COMMAND}`];
    return [];
  });
}

// The last lines of the server's stderr as the terminal may show them: every secret hidden, a cut secret dropped from
// the start of the first line (the 64 KiB buffer may have cut it) and from the end of the last, each line clipped.
export function tailLines(lines, hidden) {
  return lines.map((line, i) => {
    let text = hideSecrets(line, hidden);
    if (i === 0) text = dropCut(text, hidden, true);
    if (i === lines.length - 1) text = dropCut(text, hidden, false);
    return clip(text, TAIL_CHARS);
  });
}

function sayTail(say, tail, hidden) {
  if (tail === undefined) return;
  for (const line of tailLines(tail(TAIL_LINES), hidden)) say(`stderr: ${line}`);
}

function removeFolder(cwd) {
  if (cwd === null) return;
  try {
    fs.rmSync(cwd, { recursive: true, force: true });
  } catch {
    // the command kind's reapStale removes the run folder at the next start
  }
}

async function closeQuietly(client) {
  try {
    await client.close();
  } catch {
    // a transport that cannot close is gone for ksproxy
  }
}

// A failed start: a fixed text for the SKIPPED line, which goes to the log; the reason and the last lines of stderr,
// hidden, go to the terminal only. A stop asked meanwhile says nothing more.
function failure(err, {
  signal, say, hidden, tail, local,
}) {
  if (signal.aborted) return { ok: false, error: STOPPED };
  say(`the MCP server failed: ${hideSecrets(err.message, hidden)}`);
  sayTail(say, tail, hidden);
  return { ok: false, error: local ? FAILED : UNREACHED };
}

// After the connect: every page of tools/list within what is left of the limit, what is exported, and the live object
// the opened entry keeps, with the hidden texts that perform hides in the answers. onEnd makes the target down and says
// the last lines of stderr.
async function finishOpen(target, client, {
  signal, say, hidden, cwd, deadline, local,
}) {
  const wait = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
  let listed;
  try {
    listed = await client.listTools({ signal: wait });
  } catch (err) {
    await closeQuietly(client);
    removeFolder(cwd);
    return failure(err, {
      signal, say, hidden, tail: client.stderrTail, local,
    });
  }
  const byName = indexTools(listed.tools);
  const { exported, notes } = exportTools(target, byName, hidden);
  if (listed.capped) notes.unshift(`the MCP server lists more than ${MAX_TOOLS} tools; only the first ${MAX_TOOLS} were read`);
  const live = {
    client,
    cwd,
    say,
    hidden,
    listed: byName,
    listedCount: listed.tools.length,
    exported,
    toolNames: exported.map((item) => item.tool),
    ended: null,
    closing: false,
    pingedAt: Date.now(),
    pingState: 'up',
  };
  client.onEnd((info) => {
    live.ended = info;
    if (live.closing) return;
    say(`${endText(info)}; the target is down`);
    sayTail(say, client.stderrTail, hidden);
  });
  say(`${live.listedCount} tools listed, ${exported.length} exported`);
  return { ok: true, extras: { live }, notes };
}

async function openLocal(target, {
  env, secrets, signal, say,
}, hidden) {
  const resolved = resolveProgram(target.command[0], env);
  if (resolved.error !== undefined) return { ok: false, error: resolved.error };
  let cwd;
  try {
    cwd = fs.mkdtempSync(path.join(workRoot(env), FOLDER_PREFIX));
    fs.chmodSync(cwd, 0o700);
  } catch {
    return { ok: false, error: NO_FOLDER };
  }
  const deadline = Date.now() + limits.startMs;
  let client;
  try {
    client = await connectors.stdio({
      argv: [resolved.program, ...target.command.slice(1)],
      env: serverEnv(target, env, secrets),
      cwd,
      signal,
      limitMs: limits.startMs,
      maxMessageBytes: limits.maxMessageBytes,
      maxListBytes: limits.maxListBytes,
      hidden,
    });
  } catch (err) {
    removeFolder(cwd);
    return failure(err, {
      signal, say, hidden, tail: err.stderrTail, local: true,
    });
  }
  return finishOpen(target, client, {
    signal, say, hidden, cwd, deadline, local: true,
  });
}

async function openRemote(target, { secrets, signal, say }, hidden) {
  const auth = engineAuth(target);
  const problem = authProblem(auth, secrets);
  if (problem !== null) return { ok: false, error: problem };
  const deadline = Date.now() + limits.connectMs;
  let client;
  try {
    client = await connectors.http({
      url: target.url,
      headers: () => authHeader(auth, secrets),
      signal,
      limitMs: limits.connectMs,
      maxMessageBytes: limits.maxMessageBytes,
      maxListBytes: limits.maxListBytes,
      hidden,
    });
  } catch (err) {
    return failure(err, {
      signal, say, hidden, local: false,
    });
  }
  return finishOpen(target, client, {
    signal, say, hidden, cwd: null, deadline, local: false,
  });
}

// One value of the call as the audit keeps it: a text clipped, anything else as compact JSON, clipped.
const auditedValue = (value) => clip(typeof value === 'string' ? value : sortedJson(value, 500), 500);

function agentLines(target) {
  const names = target.tools.map((tool) => `\`${target.name}__${tool}\``);
  const pinned = Object.keys(target.arguments);
  return [
    `### MCP server \`${target.name}\`${target.description ? ` - ${target.description}` : ''}`,
    '',
    names.length === 0
      ? '- No tool of this server is in your tool list.'
      : `- Its allowed tools are in your tool list as \`${target.name}__TOOL\`: ${names.join(', ')}. Call them as you would call the server itself.`,
    `- Allowed tools: ${describeRules(target.allow)}`,
    ...(pinned.length === 0 ? [] : [`- The user fixed these arguments, which ksproxy adds to every call: ${pinned.map((name) => `\`${name}\``).join(', ')}. Leave them out.`]),
    '- A rule on an argument that holds a query (JQL, CQL or a search text) does not limit what the query reads: the user\'s account limits the data.',
    `- Answers are text: an image or a binary part is named, not shown. A call stops after ${target.timeoutSeconds} seconds.`,
  ];
}

export default {
  key: 'mcp',
  label: 'mcp',
  word: 'mcp',
  noun: 'MCP server',
  countNoun: 'MCP server(s)',
  brokered: true,
  closeLimit: 'mcpCloseMs',
  closeMs: 10000,
  sample: [{
    name: 'jira',
    command: ['uvx', 'mcp-atlassian@0.24.8'],
    env: {
      JIRA_URL: 'https://jira.example.com',
      JIRA_USERNAME: 'someone@example.com',
      JIRA_API_TOKEN: { fromEnv: 'JIRA_TOKEN' },
    },
    description: 'Jira of jira.example.com',
    allow: ['jira_get_issue', 'jira_search', { tool: 'jira_add_comment', arguments: { issue_key: 'regex(SHOP-[0-9]+)' } }],
  }],
  hint(target) {
    return target.description ? `${serverText(target)} - ${target.description}` : serverText(target);
  },
  validate(entry, where) {
    checkKeys(entry, MCP_KEYS, where);
    if (entry.review !== undefined) throw new InventoryError(`${where}: review: is not supported for mcp targets in this version`);
    const local = entry.command !== undefined;
    if (local === (entry.url !== undefined)) {
      throw new InventoryError(`${where}: give exactly one of command (a local MCP server) and url (a remote one)`);
    }
    const common = {
      kind: 'mcp',
      name: entry.name,
      description: entry.description ?? '',
      allow: checkMcpAllow(entry, where),
      arguments: checkPinned(entry.arguments, where),
      timeoutSeconds: checkInteger(entry.timeoutSeconds, 60, 1, 600, `${where}: timeoutSeconds`),
    };
    if (local) {
      const remote = REMOTE_KEYS.find((key) => entry[key] !== undefined);
      if (remote !== undefined) throw new InventoryError(`${where}: ${remote}: is only for a remote MCP server (url)`);
      return { ...common, command: checkCommand(entry.command, where), env: checkServerEnv(entry.env, where) };
    }
    if (entry.env !== undefined) throw new InventoryError(`${where}: env: is only for a local MCP server (command)`);
    return { ...common, url: checkUrl(entry.url, where), ...checkLogin(entry, where) };
  },
  secrets(target) {
    if (target.url !== undefined) return authSecrets(engineAuth(target));
    return { env: [...new Set(Object.values(target.env).filter(isObject).map((value) => value.fromEnv))], files: [] };
  },
  hiddenForms,
  // The warnings of start and check: a slow regex value; a plain env value whose name looks like a secret; and a url
  // query or a command word that seems to hold one, as neither field is hidden.
  ruleWarnings(target) {
    if (target.url !== undefined) return [...regexWarnings(target.allow), ...urlWarnings(target.url)];
    const plain = Object.entries(target.env).filter(([name, value]) => typeof value === 'string' && SECRET_LIKE.test(name));
    return [
      ...regexWarnings(target.allow),
      ...plain.map(([name]) => `env.${name}: holds a plain text, but its name looks like a secret; write {"fromEnv": NAME} so that start holds it and hides it`),
      ...commandWarnings(target.command),
    ];
  },
  openingMessage(target) {
    if (target.url !== undefined) {
      const url = new URL(target.url);
      return `${url.origin}${url.pathname}, ${loginText(target)}`;
    }
    const count = Object.keys(target.env).length;
    return `${clip(commandText(target.command), 120)}, ${count} ${count === 1 ? 'variable' : 'variables'}`;
  },
  // Nothing that goes wrong here may stop start: an open that throws skips the target.
  async open(target, ctx) {
    try {
      const hidden = hiddenOf(target, ctx.secrets);
      return await (target.url === undefined ? openLocal(target, ctx, hidden) : openRemote(target, ctx, hidden));
    } catch {
      return { ok: false, error: FAILED };
    }
  },
  async close(opened) {
    const { live } = opened;
    live.closing = true;
    await closeQuietly(live.client);
    removeFolder(live.cwd);
  },
  // The record holds the names of the exported tools as the very list that sessionFiles may still shorten.
  record(opened) {
    const { target, live } = opened;
    const server = target.url === undefined
      ? { command: target.command }
      : {
        url: target.url, login: target.login, tokenEnv: target.tokenEnv, userEnv: target.userEnv,
      };
    return {
      kind: 'mcp',
      name: target.name,
      description: target.description,
      allow: target.allow,
      ...server,
      arguments: target.arguments,
      timeoutSeconds: target.timeoutSeconds,
      tools: live.toolNames,
      state: 'up',
    };
  },
  // mcp-tools.json, only when an mcp target is open: what ksproxy mcp lists, with this process's pid and start time.
  sessionFiles(entries) {
    if (entries.length === 0) return [];
    const text = toolsFileText(entries, { pid: process.pid, processStartedAt: processStartTime(process.pid) }, (entry, count) => {
      entry.live.toolNames.splice(entry.live.toolNames.length - count, count);
      entry.live.say(`${count} more tools are not exported: the tools of a session take at most 1 MiB`);
    });
    return [{ name: TOOLS_FILE, text }];
  },
  downMessage(target, state, opened) {
    return opened.live.ended === null ? NO_PING : endText(opened.live.ended);
  },
  backMessage: 'the MCP server answers again',
  // A local server is down once its program ended; a remote one is pinged at most every pingEveryMs.
  async probe(target, { opened }) {
    const { live } = opened;
    if (live.ended !== null) return 'down';
    if (opened.target.url === undefined) return 'up';
    if (Date.now() - live.pingedAt < limits.pingEveryMs) return live.pingState;
    live.pingedAt = Date.now();
    const answered = await live.client.ping({ signal: AbortSignal.timeout(limits.probeMs) });
    live.pingState = answered ? 'up' : 'down';
    return live.pingState;
  },
  // The check of ksproxy doctor: what open listed. A local server's credential is checked only by a call, which
  // doctor never makes; a remote server listed its tools with the credential.
  doctor(opened) {
    const { live, target } = opened;
    const counts = `${live.listedCount} tools listed, ${live.toolNames.length} exported`;
    return { ok: true, detail: target.url === undefined ? `${counts}; the credential is checked only by a call` : counts };
  },
  decide: decideCall,
  // The call through the live client: the pinned arguments the tool declares added, an argument its schema does not
  // declare refused; when a pinned argument is left out, the rules matched again on what is sent, as decide matched them
  // with every pinned argument; then tools/call within the call's limit and the target's timeoutSeconds.
  async perform(target, decision, {
    timeoutMs, maxBytes, signal, input, opened,
  }) {
    const { live, target: own } = opened;
    const { call } = readCall(input);
    const notSent = (why) => ({ exitCode: 1, stdout: '', stderr: `${why}; the call was not sent` });
    const listed = live.listed.get(call.tool);
    if (listed === undefined) return notSent(`the MCP server did not list the tool ${call.tool} when the target opened`);
    if (isDuplicate(listed)) return notSent(`the MCP server lists the tool ${call.tool} more than once`);
    const pinned = Object.entries(own.arguments).filter(([name]) => listed.properties === null || listed.properties.has(name));
    const args = { ...call.arguments, ...Object.fromEntries(pinned) };
    const undeclared = listed.properties === null ? undefined : Object.keys(args).find((name) => !listed.properties.has(name));
    if (undeclared !== undefined) return notSent(`the tool ${call.tool} declares no argument ${JSON.stringify(clip(undeclared, 64))}`);
    const left = Object.keys(own.arguments).filter((name) => !Object.hasOwn(args, name));
    if (left.length > 0 && allowingRule(target.allow, call.tool, args) === undefined) {
      return notSent(`no rule allows ${call.tool} without the pinned arguments it does not declare (${left.join(', ')}), which ksproxy does not send`);
    }
    const limitMs = Math.min(timeoutMs, own.timeoutSeconds * 1000);
    const outcome = await live.client.callTool(call.tool, args, { timeoutMs: limitMs, maxBytes, signal });
    return answerOf(outcome, { maxBytes, seconds: limitMs / 1000, hidden: live.hidden });
  },
  // ksproxy check mcp NAME TOOL [JSON]: the words after the tool are one JSON object of arguments.
  checkInput([tool, ...rest]) {
    if (rest.length === 0) return { tool };
    const text = rest.join(' ');
    try {
      return { tool, arguments: JSON.parse(text) };
    } catch {
      return { tool, arguments: text };
    }
  },
  // list_targets: the exported tools of the target as the agent's tool list names them, TARGET__TOOL, from the record.
  listFields(target) {
    const tools = Array.isArray(target.tools) ? target.tools.filter((tool) => typeof tool === 'string') : [];
    return { tools: tools.map((tool) => `${target.name}__${tool}`) };
  },
  toolBullet: '- `TARGET__TOOL` - the allowed tools of each MCP server the user opened, in your tool list under the target name; `mcp_call { target, tool, arguments }` reaches the same tools.',
  cutHint: "the tool's own filter or paging arguments",
  agentSection(target) {
    return agentLines(target).join('\n');
  },
  tool: {
    name: 'mcp_call',
    nameKey: 'target',
    detailKey: 'request',
    detailIsArray: false,
    detailShape: 'object',
    // Never in tools/list: the agent sees each allowed tool as TARGET__TOOL instead.
    listed: false,
    // The call as the audit keeps it: the tool name and at most 50 arguments, each value clipped.
    auditedDetail(detail) {
      const args = isObject(detail.arguments)
        ? Object.fromEntries(Object.entries(detail.arguments).slice(0, 50).map(([name, value]) => [clip(name, 64), auditedValue(value)]))
        : null;
      return { tool: typeof detail.tool === 'string' ? clip(detail.tool, 128) : null, arguments: args };
    },
    detailText(recorded) {
      if (typeof recorded.tool !== 'string') return '(invalid)';
      const args = isObject(recorded.arguments) && Object.keys(recorded.arguments).length > 0 ? ` ${sortedJson(recorded.arguments, 2000)}` : '';
      return `${recorded.tool}${args}`;
    },
    definition: {
      name: 'mcp_call',
      description: 'Call one tool of an MCP server the user opened. Each call is checked against the target\'s allowlist and logged.',
      inputSchema: {
        type: 'object',
        required: ['target', 'tool'],
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'Target name from list_targets' },
          tool: { type: 'string', description: 'The name of the tool on the MCP server' },
          arguments: { type: 'object', description: 'The arguments of the tool' },
          timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, default: 60 },
        },
      },
    },
  },
};

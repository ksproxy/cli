import { clip } from '../../text.js';
import { hideSecrets } from './http.js';

// The answers of the doctor checks of the brokered kinds, kept in one place: how a result of an engine becomes
// { ok, detail }. A detail is short, plain, free of control characters, and never holds a secret value or a hidden form.

export const DOCTOR_MAX_BYTES = 16384;
const MAX_DETAIL = 160;
const CONTROL = /\p{Cc}/gu;
const SPACES = /\s+/g;
const STATUS = /^HTTP (\d{3})\n/;
const AUTH_REFUSED = /password authentication failed|access denied|authentication fail|not authorized|unauthorized|sasl|authenticat|credentials|noauth|wrongpass|invalid password|forbidden|permission denied/i;
const CONNECT_REFUSED = /refused/i;
const CONNECT_FAILED = /could not connect|can't connect|cannot connect|could not be reached|unreachable|connection to server|timeout expired|no route|not known|getaddrinfo/i;
const NOT_STARTED = /^could not start the program/;

// The text of a detail: every hidden text replaced, control characters and runs of spaces made one space, cut short.
export function shown(text, hidden) {
  return clip(hideSecrets(String(text), hidden).replace(CONTROL, ' ').replace(SPACES, ' ').trim(), MAX_DETAIL);
}

// Every secret value of the target and the forms the kind hides with them.
export const hiddenOf = (secrets, forms = []) => [...Object.values(secrets), ...forms];

// The function that makes { ok, detail } from a flag and a text, hiding the hidden texts in it.
const answer = (hidden) => (ok, text) => ({ ok, detail: shown(text, hidden) });

// The short reason a failure text gives, or null: authentication first, then a refused connection, then any other.
export function reasonOf(text) {
  if (AUTH_REFUSED.test(text)) return 'authentication failed';
  if (CONNECT_REFUSED.test(text)) return 'connection refused';
  return CONNECT_FAILED.test(text) ? 'could not connect' : null;
}

// The answer of a call that was stopped: the time limit, or Ctrl-C.
export const stopped = (signal) => (signal.aborted ? 'stopped' : 'timed out');

// The answer of an http check. result is the result of send. request names the request, for example GET /api/whoami.
// describe(body) gives the detail of a good answer from the parsed JSON body, or null when the answer is not the
// one expected.
export function httpVerdict(result, {
  request, describe, hidden, signal,
}) {
  const say = answer(hidden);
  if (result.timedOut) return say(false, stopped(signal));
  const status = STATUS.exec(result.stdout)?.[1];
  if (result.exitCode !== 0) {
    if (status === undefined) return say(false, 'could not connect');
    const why = status === '401' || status === '403' ? ': authentication failed' : '';
    return say(false, `HTTP ${status} from ${request}${why}`);
  }
  let detail = null;
  try {
    detail = describe(JSON.parse(result.stdout.slice(result.stdout.indexOf('\n\n') + 2)));
  } catch {
    detail = null;
  }
  return detail === null ? say(false, `HTTP ${status} from ${request}, but the answer was not as expected`) : say(true, detail);
}

// The answer of a check run through a client program. result is the result of runClient. name is the program's name.
// describe(stdout) gives the detail of a good answer, or null when the answer is not the one expected.
export function clientVerdict(result, {
  name, describe, hidden, signal,
}) {
  const say = answer(hidden);
  if (result.timedOut) return say(false, stopped(signal));
  if (NOT_STARTED.test(result.stderr)) return say(false, `${name} could not be started`);
  if (result.exitCode !== 0) return say(false, reasonOf(result.stderr) ?? `${name} exited with code ${result.exitCode}`);
  let detail = null;
  try {
    detail = describe(result.stdout);
  } catch {
    detail = null;
  }
  return detail === null ? say(false, `${name} gave an answer that was not as expected`) : say(true, detail);
}

// The answer of the redis check. result is the result of exchange.
export function respVerdict(result, { hidden, signal }) {
  const say = answer(hidden);
  if (result.timedOut) return say(false, stopped(signal));
  if (result.exitCode === 0) return result.stdout.trim() === 'PONG' ? say(true, 'PONG') : say(false, 'the server did not answer PONG');
  return say(false, reasonOf(`${result.stderr} ${result.stdout}`) ?? 'the server answered with an error');
}

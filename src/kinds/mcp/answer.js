import { isObject } from '../../checks.js';
import { endText, shownText } from '../engines/mcp-client.js';

// One outcome of callTool as the result that perform gives the core: { exitCode, stdout, stderr, timedOut?,
// truncated? }. The core writes it as "exit code: N" and the two streams, hides every secret value of the target and
// fits the output to its limit. exitCode is 0 for a result, 1 for a result with isError and for every failure but a
// time limit, which gives null and timedOut. Texts of the server that are not the answer itself (a MIME type, a part
// type, a link, an error message) have every hidden text of the target hidden first, then lose their control
// characters and are clipped, so a clip never cuts a secret in two; an HTTP error, a request that could not be sent
// and an answer cut off are fixed texts, never a body.

const ERROR_CHARS = 1000;
const MIME_CHARS = 100;
const LINK_CHARS = 1000;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const BINARY_TYPES = ['image', 'audio'];
export const INPUT_REQUIRED = 'the server asked for input, which ksproxy does not give';
// The start of the error the HTTP transport gives, without sending anything, for a value that cannot go in a header.
const NOT_SENT = 'ksproxy cannot send this call:';

const asSpaces = (text) => text.replace(CONTROLS, ' ');
const plain = (text, max, hidden) => shownText(text, { hidden, max, clean: asSpaces });
const failed = (stderr) => ({ exitCode: 1, stdout: '', stderr });

// The end of a server as the engine says it, so that a remote connection closed reads as that, not as an exit.
export { endText };

// The bytes that base64 data stands for, without decoding it.
function decodedBytes(data) {
  if (typeof data !== 'string') return 0;
  const padding = data.endsWith('==') ? 2 : Number(data.endsWith('='));
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

const mimeOf = (part, hidden) => (typeof part.mimeType === 'string' ? plain(part.mimeType, MIME_CHARS, hidden) : 'no type');

// The text of one content part, or its one line when it is not text. hidden: the texts to hide in the lines.
function partText(part, hidden) {
  if (!isObject(part)) return '[a part that is not an object, not shown]';
  if (part.type === 'text') return typeof part.text === 'string' ? part.text : '[a text part without text, not shown]';
  if (BINARY_TYPES.includes(part.type)) return `[${part.type}, ${mimeOf(part, hidden)}, ${decodedBytes(part.data)} bytes, not shown]`;
  if (part.type === 'resource' && isObject(part.resource)) {
    const { resource } = part;
    if (typeof resource.text === 'string') return resource.text;
    return `[resource, ${mimeOf(resource, hidden)}, ${decodedBytes(resource.blob)} bytes, not shown]`;
  }
  if (part.type === 'resource_link') return `[link: ${plain(part.uri ?? '', LINK_CHARS, hidden)}]`;
  return `[a part of type ${plain(part.type ?? 'none', MIME_CHARS, hidden)}, not shown]`;
}

const hasText = (part) => isObject(part) && (part.type === 'text' || (part.type === 'resource' && isObject(part.resource) && typeof part.resource.text === 'string'));

// The first maxBytes bytes of a text, cut before a character that does not fit whole, and whether it was cut.
export function cutBytes(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, cut: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString('utf8'), cut: true };
}

// structuredContent as compact JSON, used only when the result has no text part.
function structuredText(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '[structured content that cannot be written as JSON, not shown]';
  }
}

// A tools/call result: the parts joined by newlines, or structuredContent when no part is text, within maxBytes. The
// texts themselves are cut only at the end (here, and in the engine), where the core drops a piece of a secret it cut.
function resultText(result, truncated, maxBytes, hidden) {
  const content = Array.isArray(result.content) ? result.content : [];
  let text = content.map((part) => partText(part, hidden)).join('\n');
  if (!content.some(hasText) && result.structuredContent !== undefined) {
    text = [text, structuredText(result.structuredContent)].filter((piece) => piece !== '').join('\n');
  }
  const fitted = cutBytes(text, maxBytes);
  return {
    exitCode: result.isError === true ? 1 : 0, stdout: fitted.text, stderr: '', truncated: truncated || fitted.cut,
  };
}

// The result of perform for one outcome of callTool. seconds is the time limit the call had; hidden, the secret values
// of the target and their forms, the texts hidden before any text of the server is clipped.
export function answerOf(outcome, { maxBytes, seconds, hidden }) {
  if (outcome.result !== undefined) return resultText(outcome.result, outcome.truncated === true, maxBytes, hidden);
  if (outcome.timedOut) return { ...failed(`the MCP server did not answer within ${seconds} seconds`), exitCode: null, timedOut: true };
  if (outcome.rpcError !== undefined) {
    const message = plain(outcome.rpcError.message, ERROR_CHARS, hidden);
    if (message.trim() === '') return failed('the MCP server answered with an error, without a message');
    return failed(message.startsWith(NOT_SENT) ? message : `the MCP server answered with an error: ${message}`);
  }
  if (outcome.httpError !== undefined) {
    const { status, retryAfter } = outcome.httpError;
    const retry = Number.isInteger(retryAfter) && retryAfter >= 0 ? `, retry after ${retryAfter} seconds` : '';
    return failed(`the MCP server answered HTTP ${Number.isInteger(status) ? status : '?'}${retry}`);
  }
  if (outcome.unreachable) return failed('the MCP server could not be reached');
  if (outcome.cutOff) return failed('the answer of the MCP server was cut off');
  if (outcome.ended !== undefined) return failed(endText(outcome.ended));
  if (outcome.inputRequired) return failed(INPUT_REQUIRED);
  if (outcome.tooLarge) return failed('the answer of the MCP server was too large to read');
  return failed('the MCP server gave an answer that ksproxy cannot read');
}

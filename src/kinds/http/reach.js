import net from 'node:net';
import tls from 'node:tls';
import { streamConnector } from '../engines/resp.js';

const CODE_RE = /^[A-Z0-9_]{1,64}$/;
// The request of the check through a tunnel on plain http: OPTIONS *, the request that HTTP names for asking a server
// about itself, with no path of the service and no credential. Any status line is an answer.
const ASK = (host) => `OPTIONS * HTTP/1.1\r\nhost: ${host}\r\nconnection: close\r\n\r\n`;
const STATUS_LINE = 'HTTP/';

// The error code of a failed connection as plain text, or "error" when it has none that is safe to show.
export function codeOf(err) {
  return typeof err?.code === 'string' && CODE_RE.test(err.code) ? err.code : 'error';
}

// The check through a tunnel: the socket is one stream of the tunnel. For https, the TLS handshake over it, the
// certificate checked against the real host as without a tunnel; the stream alone says nothing, as it is open as soon as
// its ssh runs. For http, so that the answer comes from the service, OPTIONS * is sent and the reply must start with a
// status line. Calls finish once; gives the socket, or null when tunnel.connect() threw.
function throughTunnel(tunnel, { url, host, port, secure }, tlsOptions, finish) {
  const failed = (what, why) => finish({ ok: false, detail: `${what} from port ${port} through the tunnel (${why})` });
  let socket;
  try {
    socket = streamConnector(tunnel)({ host, servername: net.isIP(host) === 0 ? host : undefined, ...tlsOptions }, secure);
  } catch (err) {
    failed('no connection', codeOf(err));
    return null;
  }
  const answered = () => finish({ ok: true, detail: 'host answers' });
  const what = secure ? 'no TLS answer' : 'no HTTP answer';
  socket.once('error', (err) => failed(what, codeOf(err)));
  socket.once('end', () => failed(what, 'closed'));
  socket.once('close', () => failed(what, 'closed'));
  if (secure) {
    socket.once('secureConnect', answered);
    return socket;
  }
  let head = '';
  socket.on('data', (chunk) => {
    head += chunk.toString('latin1');
    if (head.length < STATUS_LINE.length) return;
    if (head.startsWith(STATUS_LINE)) answered();
    else failed(what, 'not HTTP');
  });
  socket.write(ASK(url.host));
  return socket;
}

// The doctor check of the http kind: does the host answer on its port (a TCP connection, and for https a TLS handshake
// that the certificate passes)? No HTTP request is sent. With a tunnel, see throughTunnel. Never rejects. tlsOptions
// are for a test's own certificate.
export function hostAnswers(url, { timeoutMs = 30000, signal, tunnel } = {}, tlsOptions = {}) {
  const secure = url.protocol === 'https:';
  const port = Number(url.port === '' ? (secure ? 443 : 80) : url.port);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve) => {
    const stop = AbortSignal.any(signal === undefined ? [AbortSignal.timeout(timeoutMs)] : [signal, AbortSignal.timeout(timeoutMs)]);
    let socket = null;
    let done = false;
    let tcpUp = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      stop.removeEventListener('abort', onStop);
      socket?.destroy();
      resolve(result);
    };
    const onStop = () => finish({ ok: false, detail: `no answer on port ${port} in time, or the check was stopped` });
    stop.addEventListener('abort', onStop, { once: true });
    if (stop.aborted) {
      onStop();
      return;
    }
    if (tunnel !== undefined) {
      socket = throughTunnel(tunnel, {
        url, host, port, secure,
      }, tlsOptions, finish);
      return;
    }
    const answered = () => finish({ ok: true, detail: 'host answers' });
    const failed = (err) => finish({
      ok: false,
      detail: tcpUp
        ? `the TLS handshake with port ${port} failed (${codeOf(err)})`
        : `the host did not answer on port ${port} (${codeOf(err)})`,
    });
    if (secure) {
      socket = tls.connect({
        host, port, servername: net.isIP(host) === 0 ? host : undefined, ...tlsOptions,
      });
      socket.once('connect', () => { tcpUp = true; });
      socket.once('secureConnect', answered);
    } else {
      socket = net.connect({ host, port });
      socket.once('connect', answered);
    }
    socket.once('error', failed);
  });
}

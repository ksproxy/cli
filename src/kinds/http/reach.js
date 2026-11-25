import net from 'node:net';
import tls from 'node:tls';

const CODE_RE = /^[A-Z0-9_]{1,64}$/;

// The error code of a failed connection as plain text, or "error" when it has none that is safe to show.
export function codeOf(err) {
  return typeof err?.code === 'string' && CODE_RE.test(err.code) ? err.code : 'error';
}

// The doctor check of the http kind: does the host answer on its port (a TCP connection, and for https a TLS handshake
// that the certificate passes)? No HTTP request is sent. Never rejects. tlsOptions are for a test's own certificate.
export function hostAnswers(url, { timeoutMs = 30000, signal } = {}, tlsOptions = {}) {
  const secure = url.protocol === 'https:';
  const port = Number(url.port === '' ? (secure ? 443 : 80) : url.port);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve) => {
    const stop = AbortSignal.any(signal === undefined ? [AbortSignal.timeout(timeoutMs)] : [signal, AbortSignal.timeout(timeoutMs)]);
    let socket;
    let tcpUp = false;
    const finish = (result) => {
      stop.removeEventListener('abort', onStop);
      socket.destroy();
      resolve(result);
    };
    const onStop = () => finish({ ok: false, detail: `no answer on port ${port} in time, or the check was stopped` });
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
    stop.addEventListener('abort', onStop, { once: true });
    if (stop.aborted) onStop();
  });
}

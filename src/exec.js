import { spawn } from 'node:child_process';

// The last size bytes written to it, in one buffer of that size: write(chunk) adds a chunk, bytes() gives them in order.
function lastBytes(size) {
  const buffer = Buffer.alloc(size);
  let at = 0;
  let total = 0;
  return {
    write(chunk) {
      const piece = chunk.subarray(Math.max(0, chunk.length - size));
      const first = Math.min(piece.length, size - at);
      piece.copy(buffer, at, 0, first);
      piece.copy(buffer, 0, first);
      at = (at + piece.length) % size;
      total += piece.length;
    },
    bytes: () => (total < size ? buffer.subarray(0, total) : Buffer.concat([buffer.subarray(at), buffer.subarray(0, at)])),
  };
}

// signal: an AbortSignal that kills the child at once. stopAtLimit: kill the child as soon as a stream passes maxBytes.
// tailBytes: keep the last tailBytes bytes of each stream, whatever maxBytes kept, as stdoutTail and stderrTail.
// Without them run behaves as it always did. cutOff is true when the grace period after the exit ended with a stream
// still open (a child of the program still writing): the streams were destroyed there, so they did not end on their own.
export function run(file, args, {
  timeoutMs = 60000, maxBytes = 262144, env = process.env, inherit = false, cwd, graceMs = 500, signal, stopAtLimit = false,
  tailBytes = 0,
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const result = {
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTail: null,
      stderrTail: null,
      truncated: false,
      cutOff: false,
      timedOut: false,
      durationMs: 0,
      spawnError: null,
    };
    let settled = false;
    let timer = null;
    let killTimer = null;
    let graceTimer = null;
    let onAbort = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (onAbort !== null) signal.removeEventListener('abort', onAbort);
      if (!inherit && child && Number.isInteger(child.pid)) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // the group is already gone
        }
      }
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
      result.durationMs = Date.now() - started;
      resolve(result);
    };

    let child;
    try {
      child = spawn(file, args, {
        env, cwd, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], detached: !inherit,
      });
    } catch (err) {
      result.spawnError = err.message;
      finish();
      return;
    }

    const chunks = { stdout: [], stderr: [] };
    const kept = { stdout: 0, stderr: 0 };
    const tails = tailBytes > 0 ? { stdout: lastBytes(tailBytes), stderr: lastBytes(tailBytes) } : null;
    const collect = (name) => (chunk) => {
      result[`${name}Bytes`] += chunk.length;
      tails?.[name].write(chunk);
      const room = maxBytes - kept[name];
      if (room > 0) {
        const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
        chunks[name].push(piece);
        kept[name] += piece.length;
      }
      if (chunk.length > room) {
        result.truncated = true;
        if (stopAtLimit) signalChild('SIGKILL');
      }
    };
    const signalChild = (signal) => {
      if (inherit) {
        child.kill(signal);
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    const collectOutput = () => {
      result.stdout = Buffer.concat(chunks.stdout).toString('utf8');
      result.stderr = Buffer.concat(chunks.stderr).toString('utf8');
      result.stdoutTail = tails?.stdout.bytes() ?? null;
      result.stderrTail = tails?.stderr.bytes() ?? null;
    };

    let open = 0;
    let exited = false;
    const maybeDone = () => {
      if (exited && open === 0) {
        collectOutput();
        finish();
      }
    };
    if (!inherit) {
      for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
        open += 1;
        stream.on('data', collect(name));
        stream.on('close', () => {
          open -= 1;
          maybeDone();
        });
      }
    }

    if (signal !== undefined) {
      onAbort = () => signalChild('SIGKILL');
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => {
      result.timedOut = true;
      signalChild('SIGTERM');
      killTimer = setTimeout(() => signalChild('SIGKILL'), 2000);
    }, timeoutMs);

    child.on('error', (err) => {
      result.spawnError = err.message;
      finish();
    });
    child.on('exit', (code, signal) => {
      result.exitCode = code;
      result.signal = signal;
      exited = true;
      if (inherit) return;
      graceTimer = setTimeout(() => {
        result.cutOff = true;
        child.stdout.destroy();
        child.stderr.destroy();
        collectOutput();
        finish();
      }, graceMs);
      maybeDone();
    });
    if (inherit) {
      child.on('close', () => {
        collectOutput();
        finish();
      });
    }
  });
}

export function minimalEnv(env = process.env, extra = {}, { own = true } = {}) {
  const out = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (own && key.startsWith('KSPROXY_')) out[key] = value;
  }
  return { ...out, ...extra };
}

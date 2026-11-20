import { spawn } from 'node:child_process';

export function run(file, args, {
  timeoutMs = 60000, maxBytes = 262144, env = process.env, inherit = false, cwd, graceMs = 500,
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
      truncated: false,
      timedOut: false,
      durationMs: 0,
      spawnError: null,
    };
    let settled = false;
    let timer = null;
    let killTimer = null;
    let graceTimer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
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
    const collect = (name) => (chunk) => {
      result[`${name}Bytes`] += chunk.length;
      const room = maxBytes - kept[name];
      if (room > 0) {
        const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
        chunks[name].push(piece);
        kept[name] += piece.length;
      }
      if (chunk.length > room) result.truncated = true;
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

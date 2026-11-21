import fs from 'node:fs';
import path from 'node:path';
import { minimalEnv, run } from '../../exec.js';
import { ensureDir, stateDir } from '../../paths.js';

// The command engine runs one client program for a brokered kind: no shell, an empty private working folder, a
// small environment with the entries the kind gives, and a stop at the output limit.

export const WORK_FOLDER = 'run';
const WORK_PREFIX = 'cmd-';

// The folder under the state folder that holds the working folder of each call: mode 0700, never a link or a file.
export function workRoot(env) {
  const root = path.join(stateDir(env), WORK_FOLDER);
  ensureDir(root);
  if (!fs.lstatSync(root).isDirectory()) throw new Error('the working folder root is not a folder');
  return root;
}

// program: an absolute path the kind resolved. fixedArgs: the arguments the kind or the user fixed. words: the
// arguments from the call, each passed as one argument (a SQL statement is one word). env: the environment of
// ksproxy start, of which only PATH, HOME, LANG, LC_ALL and TMPDIR reach the child. childEnv: the secrets and plain
// values the child gets in its environment. folderPaths: entries of the child's environment whose value is the path of
// the given file name inside the working folder; the file is not created. homeInWorkFolder: HOME of the child is the
// working folder, so what a client keeps in its home folder (a log, its settings) goes away with it. The working
// folder is removed in every case; a failure to create it throws.
export async function runClient({
  program, fixedArgs = [], words = [], env, childEnv = {}, folderPaths = {}, homeInWorkFolder = false, timeoutMs, maxBytes, signal,
}) {
  const cwd = fs.mkdtempSync(path.join(workRoot(env), WORK_PREFIX));
  try {
    fs.chmodSync(cwd, 0o700);
    const inFolder = Object.fromEntries(Object.entries(folderPaths).map(([key, name]) => [key, path.join(cwd, name)]));
    const home = homeInWorkFolder ? { HOME: cwd } : {};
    const result = await run(program, [...fixedArgs, ...words], {
      env: minimalEnv(env, { ...childEnv, ...inFolder, ...home }, { own: false }), cwd, timeoutMs, maxBytes, signal, stopAtLimit: true,
    });
    if (result.spawnError !== null) {
      return {
        exitCode: null, stdout: '', stderr: `could not start the program: ${result.spawnError}`, timedOut: false, truncated: false,
      };
    }
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut || signal?.aborted === true,
      truncated: result.truncated,
    };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

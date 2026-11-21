import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { callTool } from '../src/tools.js';
import {
  cleanupAll, launch, makeWorld, ready, stopWith,
} from './start-helpers.js';

after(() => cleanupAll());

const ENV_FILE = ['.', 'env'].join('');

const sessionOf = (world) => JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8'));
const warnLine = (run) => run.proc.stderr.text.split('\n').find((line) => /loc\s+repo\s+WARN/.test(line));

async function world(files, extra = {}) {
  const w = await makeWorld({ ssh: [], local: [{ name: 'repo', allow: ['ls ...', 'cat *'], ...extra }] });
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(w.proj, file)), { recursive: true });
    fs.writeFileSync(path.join(w.proj, file), 'x\n');
  }
  return w;
}

test('protect is recorded in the session, and a plain folder gets no warning', async () => {
  const w = await world(['secrets/token'], { protect: ['secrets'] });
  const run = launch(w, { local: ['repo'] });
  await ready(run);
  assert.deepEqual(sessionOf(w).targets[0].protect, ['secrets']);
  assert.equal(warnLine(run), undefined, run.proc.stderr.text);

  const refused = await callTool('local_exec', { target: 'repo', command: 'cat secrets/token' }, w.env);
  assert.equal(refused.isError, true);
  assert.ok(
    refused.text.startsWith('REFUSED (local repo): the argument secrets/token is, lies inside or contains a path this target protects'),
    refused.text,
  );
  const ok = await callTool('local_exec', { target: 'repo', command: 'cat a.txt' }, w.env);
  assert.equal(ok.isError, false, ok.text);
  assert.equal(await stopWith(run), 0);
});

test('a target without protect has no protect in the session and no warning', async () => {
  const w = await world([]);
  const run = launch(w, { local: ['repo'] });
  await ready(run);
  assert.equal(Object.hasOwn(sessionOf(w).targets[0], 'protect'), false);
  assert.equal(warnLine(run), undefined, run.proc.stderr.text);
  assert.equal(await stopWith(run), 0);
});

test('secret-looking names at the top of the folder are named in a WARN line', async () => {
  const w = await world([ENV_FILE, 'server.pem']);
  const run = launch(w, { local: ['repo'] });
  await ready(run);
  assert.match(
    run.proc.stderr.text,
    /loc\s+repo\s+WARN\s+holds \.env, server\.pem: list them in "protect" to also refuse commands given the whole folder/,
  );
  assert.equal(await stopWith(run), 0);
});

test('more than three names are cut to three and counted', async () => {
  const w = await world([ENV_FILE, 'a.key', 'b.key', 'c.key', 'd.key']);
  const run = launch(w, { local: ['repo'] });
  await ready(run);
  assert.match(
    run.proc.stderr.text,
    /loc\s+repo\s+WARN\s+holds \.env, a\.key, b\.key and 2 more: list them in "protect" to also refuse commands given the whole folder/,
  );
  assert.equal(await stopWith(run), 0);
});

test('names listed in protect are not warned about, whatever the letter case', async () => {
  const listed = await world([ENV_FILE, 'server.pem'], { protect: [ENV_FILE, 'server.pem'] });
  const first = launch(listed, { local: ['repo'] });
  await ready(first);
  assert.equal(warnLine(first), undefined, first.proc.stderr.text);
  assert.equal(await stopWith(first), 0);

  const capitals = await world([ENV_FILE], { protect: [ENV_FILE.toUpperCase()] });
  const second = launch(capitals, { local: ['repo'] });
  await ready(second);
  assert.equal(warnLine(second), undefined, second.proc.stderr.text);
  assert.equal(await stopWith(second), 0);
});

test('a name with an escape character and a newline is shown only in escaped form', async (t) => {
  const w = await world([]);
  const name = 'bad\u001b[31m\nFAKE.pem';
  try {
    fs.writeFileSync(path.join(w.proj, name), 'x\n');
  } catch {
    t.skip('this file system refuses the name');
    return;
  }
  const run = launch(w, { local: ['repo'] });
  await ready(run);
  const text = run.proc.stderr.text;
  assert.match(text, /loc\s+repo\s+WARN/);
  assert.equal(text.includes('bad\u001b'), false);
  assert.equal(text.includes('bad\u001b[31m\nFAKE.pem'), false);
  assert.equal(text.includes('\nFAKE.pem'), false);
  assert.equal(await stopWith(run), 0);
});

test('a folder the session cannot list opens without a warning', { skip: process.getuid?.() === 0 }, async () => {
  const w = await world([ENV_FILE]);
  fs.chmodSync(w.proj, 0o311);
  try {
    const run = launch(w, { local: ['repo'] });
    await ready(run);
    assert.equal(warnLine(run), undefined, run.proc.stderr.text);
    assert.match(run.proc.stderr.text, /loc\s+repo\s+UP/);
    assert.equal(await stopWith(run), 0);
  } finally {
    fs.chmodSync(w.proj, 0o755);
  }
});

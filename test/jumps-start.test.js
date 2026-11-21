import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { agentMdText } from '../src/agent-md.js';
import {
  cleanupAll, launch, makeWorld, ready, stopWith,
} from './start-helpers.js';

after(() => cleanupAll());

const LINE = '- This server is reached through a further ssh step that the user set up; your command runs on the final server.';
const FIRST = 'ssh -i .ssh/prod_rsa ubuntu@172.16.1.210';
const SECOND = 'ssh -p 2222 deploy@10.9.8.7';
const SECRETS = ['prod_rsa', '172.16', 'ubuntu', '.ssh', '2222', 'deploy', '10.9.8.7', 'BatchMode'];

const sessionOf = (world) => JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8'));
const agentMd = (world) => fs.readFileSync(path.join(world.sessionDir, 'AGENT.md'), 'utf8');

test('jumps are recorded, shown as a count in the opening line and kept out of AGENT.md', async () => {
  const w = await makeWorld({
    ssh: [
      {
        name: 'one', host: 'sff_proxy', jumps: [FIRST], allow: ['uptime'],
      },
      {
        name: 'two', host: 'sff_two', jumps: [FIRST, SECOND], allow: ['uptime'],
      },
      { name: 'plain', host: 'plain.example.com', allow: ['uptime'] },
    ],
  });
  const run = launch(w, { all: true });
  await ready(run);
  const targets = sessionOf(w).targets;
  assert.deepEqual(targets[0].jumps, [FIRST]);
  assert.deepEqual(targets[1].jumps, [FIRST, SECOND]);
  assert.equal(Object.hasOwn(targets[2], 'jumps'), false);

  const stderr = run.proc.stderr.text;
  assert.match(stderr, /ssh\s+one\s+OPENING\s+sff_proxy, then 1 jump\b(?!s)/);
  assert.match(stderr, /ssh\s+two\s+OPENING\s+sff_two, then 2 jumps/);
  assert.match(stderr, /ssh\s+plain\s+OPENING\s+plain\.example\.com\s*$/m);
  for (const word of SECRETS) assert.equal(stderr.includes(word), false, word);

  const md = agentMd(w);
  assert.equal(md.split(LINE).length - 1, 2);
  for (const word of SECRETS) assert.equal(md.includes(word), false, word);
  const plainSection = md.slice(md.indexOf('ssh server `plain`'), md.indexOf('## Off limits'));
  assert.equal(plainSection.includes('further ssh step'), false);
  assert.equal(await stopWith(run), 0);
});

test('agentMdText adds the line only for a target that has jumps', () => {
  const t = { kind: 'ssh', name: 'web1', description: '', allow: ['uptime'] };
  assert.equal(agentMdText({ targets: [t] }).includes(LINE), false);
  assert.equal(agentMdText({ targets: [{ ...t, jumps: [FIRST] }] }).includes(LINE), true);
});

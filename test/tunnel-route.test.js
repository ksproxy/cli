import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { InventoryError } from '../src/checks.js';
import { run } from '../src/exec.js';
import {
  TUNNEL_DESTINATION, checkTunnel, isolationArgs, streamArgs,
} from '../src/kinds/engines/tunnel.js';
import { JUMP_SETTINGS } from '../src/kinds/ssh/master.js';
import { tempDir } from './temp.js';

const W = 'postgres[0] (orders)';
const SOCKET = '/state/s/tnl-0a1b2c3d';

// The options of the design, written out here so that a change in the code shows as a failure.
const L = [
  '-F', '/dev/null',
  '-o', `ControlPath=${SOCKET}`,
  '-o', 'ControlMaster=no',
  '-o', 'HostName=ksproxy.invalid',
  '-o', 'ProxyCommand=/usr/bin/false',
  '-o', 'BatchMode=yes',
  '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'IdentityAgent=none',
  '-o', 'IdentitiesOnly=yes',
  '-o', 'IdentityFile=/dev/null',
  '-o', 'PubkeyAuthentication=no',
  '-o', 'PasswordAuthentication=no',
  '-o', 'KbdInteractiveAuthentication=no',
];

const fails = (value, message) => {
  assert.throws(() => checkTunnel(value, W), (err) => {
    assert.ok(err instanceof InventoryError, `${JSON.stringify(value)} gave ${err}`);
    assert.equal(err.message, message, JSON.stringify(value));
    return true;
  });
};

test('checkTunnel gives the host and the jumps, the jumps an empty list when there are none', () => {
  assert.deepEqual(checkTunnel({ host: 'bastion1' }, W), { host: 'bastion1', jumps: [] });
  assert.deepEqual(checkTunnel({ host: 'bastion1', jumps: [] }, W), { host: 'bastion1', jumps: [] });
  assert.deepEqual(
    checkTunnel({ host: 'ops@bastion1.example.com', jumps: ['ssh  -i .ssh/app_key\topsuser@192.0.2.10', 'ssh -p 2222 u2@192.0.2.20'] }, W),
    { host: 'ops@bastion1.example.com', jumps: ['ssh -i .ssh/app_key opsuser@192.0.2.10', 'ssh -p 2222 u2@192.0.2.20'] },
  );
  const five = Array.from({ length: 5 }, (_, i) => `ssh u@192.0.2.${i + 1}`);
  assert.deepEqual(checkTunnel({ host: 'b', jumps: five }, W).jumps, five);
  for (const key of JUMP_SETTINGS) {
    assert.doesNotThrow(() => checkTunnel({ host: 'b', jumps: [`ssh -o ${key}=x h`] }, W), key);
  }
});

test('checkTunnel refuses a value that is not an object, an unknown key and a bad host', () => {
  for (const value of [undefined, null, 'bastion1', 7, [], ['bastion1']]) {
    fails(value, `${W}: tunnel: must be an object with "host" and optional "jumps"`);
  }
  fails({ host: 'b', localPort: 15432 }, `${W}: tunnel: unknown key "localPort"`);
  fails({ host: 'b', remote: '10.0.0.5:5432' }, `${W}: tunnel: unknown key "remote"`);
  const hostRule = `${W}: tunnel.host: must match /^[A-Za-z0-9][A-Za-z0-9._@-]*$/ (no leading "-")`;
  for (const host of [undefined, '', '-oProxyCommand=x', 'a b', 'a;b', 'a/b', 7, null]) fails({ host }, hostRule);
  fails({}, hostRule);
});

test('checkTunnel refuses jumps that are not a list of at most five', () => {
  const rule = `${W}: tunnel.jumps: must be a list of 0 to 5 ssh commands`;
  for (const jumps of [null, 'ssh h', {}, 5, Array.from({ length: 6 }, () => 'ssh h')]) fails({ host: 'b', jumps }, rule);
});

test('checkTunnel refuses each jump as an ssh target does, with its place', () => {
  const at = (j) => `${W}: tunnel.jumps[${j}]`;
  for (const jump of [7, null, '', '   ', {}]) {
    fails({ host: 'b', jumps: ['ssh h', jump] }, `${at(1)}: must be an ssh command, for example "ssh -i .ssh/key user@server"`);
  }
  fails({ host: 'b', jumps: ['ssh -i ~/.ssh/k h'] }, `${at(0)}: "~" is not allowed; a path without a leading "/" starts in the home folder of that login`);
  const cases = [
    ['ls h', 'must start with "ssh"'],
    ['ssh -A h', 'option -A is not supported; the supported options are -i -p -l -o -J, each followed by its value as a separate word; for other settings use -o Key=Value'],
    ['ssh -i', 'option -i needs a value'],
    ['ssh -i -x h', 'the value of -i may not start with "-"'],
    ['ssh -o ProxyCommand=x h', `the setting ProxyCommand is not supported in a jump; supported: ${JUMP_SETTINGS.join(' ')}`],
    ['ssh -o Port h', 'the value of -o must have the form Key=Value'],
    ['ssh =h', 'a word may not start with "=" or contain "==" or ":="'],
    ['ssh', 'needs a server after the options'],
    ['ssh h -W 10.0.0.5:5432', 'nothing may follow the server; the command comes from the allow list'],
    ['ssh h uptime', 'nothing may follow the server; the command comes from the allow list'],
  ];
  for (const [jump, message] of cases) fails({ host: 'b', jumps: [jump] }, `${at(0)}: ${message}`);
  for (const ch of [';', '|', '&', '$', '`', '"', "'", '(', '*', '?', '[', '>', '<', '\\', '!', '{', '#']) {
    assert.throws(() => checkTunnel({ host: 'b', jumps: [`ssh u@h${ch}x`] }, W), /: tunnel\.jumps\[0\]: character .* is not allowed/, ch);
  }
});

test('the isolation options are exactly the ones of the design', () => {
  assert.deepEqual(isolationArgs(SOCKET), L);
  assert.equal(TUNNEL_DESTINATION, 'ksproxy-tunnel');
});

test('without jumps the shared connection itself connects: -W, the address, the token -- and the fixed name', () => {
  assert.deepEqual(streamArgs({ socket: SOCKET, jumps: [], to: '10.0.0.5:27017' }), [...L, '-W', '10.0.0.5:27017', '--', 'ksproxy-tunnel']);
  assert.deepEqual(streamArgs({ socket: SOCKET, jumps: [], to: '[2001:db8::5]:5432' }), [...L, '-W', '[2001:db8::5]:5432', '--', 'ksproxy-tunnel']);
  assert.deepEqual(streamArgs({ socket: SOCKET, jumps: [], to: 'db_1.internal:6379' }).slice(-4), ['-W', 'db_1.internal:6379', '--', 'ksproxy-tunnel']);
});

test('with one jump the first server runs one ssh with -W just before its server and nothing after it', () => {
  assert.deepEqual(streamArgs({ socket: SOCKET, jumps: ['ssh -i .ssh/app_key opsuser@192.0.2.10'], to: '10.0.0.5:27017' }), [
    ...L, '-T', '-e', 'none', '--', 'ksproxy-tunnel',
    'ssh -T -e none -o BatchMode=yes -i .ssh/app_key -o ConnectTimeout=10 -W 10.0.0.5:27017 opsuser@192.0.2.10',
  ]);
});

test('with two jumps each one is nested after the -- of the one before it, -W only in the last', () => {
  assert.deepEqual(streamArgs({ socket: SOCKET, jumps: ['ssh -i .ssh/k1 u1@192.0.2.10', 'ssh -i .ssh/k2 u2@192.0.2.20'], to: '10.0.0.5:27017' }), [
    ...L, '-T', '-e', 'none', '--', 'ksproxy-tunnel',
    'ssh -T -e none -o BatchMode=yes -i .ssh/k1 -o ConnectTimeout=10 u1@192.0.2.10 -- ssh -T -e none -o BatchMode=yes -i .ssh/k2 -o ConnectTimeout=10 -W 10.0.0.5:27017 u2@192.0.2.20',
  ]);
  const three = streamArgs({ socket: SOCKET, jumps: ['ssh a', 'ssh -o Port=2222 b', 'ssh c'], to: 'db.internal:5432' });
  assert.equal(three.length, L.length + 6);
  assert.equal(
    three.at(-1),
    'ssh -T -e none -o BatchMode=yes -o ConnectTimeout=10 a -- ssh -T -e none -o BatchMode=yes -o Port=2222 -o ConnectTimeout=10 b -- ssh -T -e none -o BatchMode=yes -o ConnectTimeout=10 -W db.internal:5432 c',
  );
});

test('every word of the nested command is plain, so each shell on the way reads it as it is written', () => {
  const jumps = Array.from({ length: 5 }, (_, i) => `ssh -i .ssh/k${i} -o UserKnownHostsFile=/etc/ksproxy/known_hosts -p 22 -l ops u${i}@192.0.2.${i + 1}`);
  const command = streamArgs({ socket: SOCKET, jumps, to: 'db-1.example.com:65535' }).at(-1);
  for (const word of command.split(' ')) assert.match(word, /^[A-Za-z0-9_@%+=:,./-]+$/);
  assert.equal(command.split(' -W ').length, 2);
  assert.ok(command.endsWith('-W db-1.example.com:65535 u4@192.0.2.5'));
});

test('a service address that is not host:port or [IPv6]:port is refused, and its value is never in the message', () => {
  const bad = [
    undefined, null, 5432, '', 'db', 'db:', ':5432', 'db:0', 'db:65536', 'db:05432', 'db:54x', 'db:-1', 'db:5432:1',
    '/tmp/redis.sock', '/tmp/redis.sock:5432', 'unix:/tmp/s', 'db/x:5432', '-oProxyCommand=x:22', '.db:5432', 'db.:5432',
    'db-:5432', '-db:5432', 'a..b:5432', 'db 1:5432', 'db;id:5432', 'db$x:5432', 'db`x`:5432', '$(id):5432',
    'db\n:5432', 'db*:5432', '::1:5432', '2001:db8::5:5432', '[2001:db8::5]', '[2001:db8::5]:', '[2001:db8::5]:0',
    '[db]:5432', '[::1%lo0]:5432', '[::g]:5432', '[[::1]]:5432', `${'a'.repeat(64)}:5432`, `${'a.'.repeat(127)}a:5432`,
  ];
  for (const to of bad) {
    for (const jumps of [[], ['ssh h']]) {
      assert.throws(() => streamArgs({ socket: SOCKET, jumps, to }), { message: 'the service address must be host:port or [IPv6]:port' }, String(to));
    }
  }
  assert.doesNotThrow(() => streamArgs({ socket: SOCKET, jumps: [], to: `${'a'.repeat(63)}.b:1` }));
});

test('an IPv6 address is refused with jumps: its brackets would reach a shell', () => {
  for (const to of ['[2001:db8::5]:5432', '[::1]:6379', '[::ffff:192.0.2.1]:80']) {
    assert.doesNotThrow(() => streamArgs({ socket: SOCKET, jumps: [], to }));
    assert.throws(() => streamArgs({ socket: SOCKET, jumps: ['ssh h'], to }), { message: 'an IPv6 service address cannot be used with jumps' });
  }
});

test('jumps that are not a list of at most five, or a jump that breaks the grammar, are refused', () => {
  for (const jumps of [undefined, null, 'ssh h', Array.from({ length: 6 }, () => 'ssh h')]) {
    assert.throws(() => streamArgs({ socket: SOCKET, jumps, to: 'db:5432' }), { message: 'jumps must be a list of 0 to 5 ssh commands' });
  }
  assert.throws(() => streamArgs({ socket: SOCKET, jumps: ['ssh h; id'], to: 'db:5432' }), /character ";" is not allowed/);
  assert.throws(() => streamArgs({ socket: SOCKET, jumps: ["ssh 'h'"], to: 'db:5432' }), /is not allowed/);
  assert.throws(() => streamArgs({ socket: SOCKET, jumps: ['ssh -o ProxyCommand=id h'], to: 'db:5432' }), /the setting ProxyCommand is not supported/);
  assert.throws(() => streamArgs({ socket: SOCKET, jumps: ['ssh h id'], to: 'db:5432' }), /nothing may follow the server/);
  assert.throws(() => streamArgs({ socket: SOCKET, jumps: ['ssh =h'], to: 'db:5432' }), /a word may not start with "="/);
});

// The real OpenSSH client, given the isolation options and a socket that does not exist, must fail by itself and
// never connect anywhere: it reads no configuration, and its only way to a host is ProxyCommand=/usr/bin/false.
const realSsh = ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh'].find((p) => fs.existsSync(p));

test('a stream ssh whose socket is gone fails and reaches no host: the real ssh client', { skip: realSsh === undefined && 'no ssh client on this machine' }, async () => {
  const dir = tempDir('ksproxy-tnl-real-');
  let reached = 0;
  const server = net.createServer((s) => {
    reached += 1;
    s.destroy();
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const to = `127.0.0.1:${server.address().port}`;
  try {
    const env = { PATH: '/usr/bin:/bin', HOME: dir, LANG: 'C' };
    for (const jumps of [[], ['ssh -i .ssh/k opsuser@127.0.0.1']]) {
      const args = streamArgs({ socket: path.join(dir, 'gone', 'tnl-00000000'), jumps, to });
      const r = await run(realSsh, args, { env, timeoutMs: 20000 });
      assert.equal(r.spawnError, null);
      assert.equal(r.timedOut, false);
      assert.equal(r.exitCode, 255, r.stderr);
      assert.equal(r.stdout, '');
    }
    assert.equal(reached, 0);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    server.close();
  }
});

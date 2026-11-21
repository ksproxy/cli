import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JUMP_SETTINGS, MAX_JUMPS, jumpPrefix, parseJump, zshEqualsWord,
} from '../src/ssh.js';

test('one jump gives the exact prefix', () => {
  assert.equal(
    jumpPrefix(['ssh -i .ssh/prod_rsa ubuntu@172.16.1.210']),
    'ssh -T -o BatchMode=yes -i .ssh/prod_rsa -o ConnectTimeout=10 ubuntu@172.16.1.210 --',
  );
});

test('two jumps give the exact prefix, innermost last', () => {
  assert.equal(
    jumpPrefix(['ssh -i a u@b', 'ssh -p 2222 v@c']),
    'ssh -T -o BatchMode=yes -i a -o ConnectTimeout=10 u@b -- ssh -T -o BatchMode=yes -p 2222 -o ConnectTimeout=10 v@c --',
  );
});

test('a jump without options has no double space', () => {
  assert.equal(jumpPrefix(['ssh h']), 'ssh -T -o BatchMode=yes -o ConnectTimeout=10 h --');
});

test('the connect timeout comes after the options of the user, so the first value wins', () => {
  assert.equal(
    jumpPrefix(['ssh -o ConnectTimeout=30 h']),
    'ssh -T -o BatchMode=yes -o ConnectTimeout=30 -o ConnectTimeout=10 h --',
  );
});

test('no jumps give an empty prefix', () => {
  assert.equal(jumpPrefix(undefined), '');
});

test('the limit is five', () => {
  assert.equal(MAX_JUMPS, 5);
  assert.notEqual(jumpPrefix(Array.from({ length: 5 }, () => 'ssh h')), null);
});

test('a shape that cannot be used gives null', () => {
  const six = Array.from({ length: 6 }, () => 'ssh h');
  const bad = [
    'ssh h', null, {}, [], six, [7], ['ls x'], ['ssh -A u@h'], ['ssh h', 'ssh -i'], ['ssh h;ls'], ['ssh =h'],
    ['ssh x==h'], ['ssh -o ProxyCommand=x h'], ['ssh h ls'],
  ];
  for (const one of bad) assert.equal(jumpPrefix(one), null, JSON.stringify(one));
});

test('parseJump returns the options and the server', () => {
  assert.deepEqual(parseJump(['ssh', '-i', 'k', '-o', 'Port=22', 'u@h']), { options: ['-i', 'k', '-o', 'Port=22'], server: 'u@h' });
  assert.deepEqual(parseJump(['ssh', 'h']), { options: [], server: 'h' });
});

test('the supported settings are exactly the listed ones', () => {
  assert.deepEqual(JUMP_SETTINGS, [
    'Port', 'User', 'IdentityFile', 'IdentitiesOnly', 'StrictHostKeyChecking', 'UserKnownHostsFile', 'HostKeyAlias',
    'ConnectTimeout', 'AddressFamily', 'LogLevel', 'ServerAliveInterval', 'ServerAliveCountMax', 'ProxyJump', 'Compression',
    'HostKeyAlgorithms', 'PubkeyAcceptedAlgorithms', 'KexAlgorithms', 'Ciphers', 'MACs', 'PreferredAuthentications',
  ]);
  for (const key of JUMP_SETTINGS) assert.doesNotThrow(() => parseJump(['ssh', '-o', `${key}=x`, 'h']), key);
});

test('a key in another letter case is accepted as written', () => {
  assert.deepEqual(parseJump(['ssh', '-o', 'loglevel=ERROR', 'h']).options, ['-o', 'loglevel=ERROR']);
  assert.deepEqual(parseJump(['ssh', '-o', 'PORT=22', 'h']).options, ['-o', 'PORT=22']);
});

test('a setting that is not listed is refused with the list', () => {
  const keys = [
    'ProxyCommand', 'LocalCommand', 'PermitLocalCommand', 'RemoteForward', 'LocalForward', 'DynamicForward',
    'KnownHostsCommand', 'ForwardAgent',
  ];
  for (const key of keys) {
    assert.throws(
      () => parseJump(['ssh', '-o', `${key}=x`, 'h']),
      { message: `the setting ${key} is not supported in a jump; supported: ${JUMP_SETTINGS.join(' ')}` },
      key,
    );
  }
});

test('-o needs Key=Value with a value', () => {
  for (const bad of ['Port', 'Port=', 'x']) {
    assert.throws(() => parseJump(['ssh', '-o', bad, 'h']), /the value of -o must have the form Key=Value/, bad);
  }
});

test('a word that zsh may rewrite is refused', () => {
  const message = 'a word may not start with "=" or contain "==" or ":="';
  for (const bad of ['=h', 'x==h', 'a=b:=c']) {
    assert.throws(() => parseJump(['ssh', bad]), { message }, bad);
  }
  assert.throws(() => parseJump(['ssh', '-o', 'HostKeyAlias=a==b', 'h']), { message });
});

test('a flag that is not supported points to -o Key=Value', () => {
  assert.throws(() => parseJump(['ssh', '-A', 'h']), /; for other settings use -o Key=Value$/);
});

test('zshEqualsWord names the three shapes', () => {
  assert.equal(zshEqualsWord('=a'), true);
  assert.equal(zshEqualsWord('a==b'), true);
  assert.equal(zshEqualsWord('a:=b'), true);
  assert.equal(zshEqualsWord('a=b:c'), false);
});

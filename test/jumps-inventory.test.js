import test from 'node:test';
import assert from 'node:assert/strict';
import { InventoryError, validateInventory } from '../src/inventory.js';

const SSH = { name: 'app1', host: 'bastion1', allow: ['uptime'] };
const withJumps = (jumps, extra = {}) => ({ ssh: [{ ...SSH, jumps, ...extra }] });

function rejects(raw, pattern) {
  assert.throws(() => validateInventory(raw), (err) => {
    assert.ok(err instanceof InventoryError);
    assert.match(err.message, pattern);
    return true;
  });
}

test('a target without jumps has no jumps key', () => {
  const [t] = validateInventory({ ssh: [SSH] }).ssh;
  assert.equal(Object.hasOwn(t, 'jumps'), false);
});

test('one jump is kept, and extra spaces are normalised', () => {
  const [t] = validateInventory(withJumps(['ssh   -i .ssh/app_key \t opsuser@192.0.2.10 '])).ssh;
  assert.deepEqual(t.jumps, ['ssh -i .ssh/app_key opsuser@192.0.2.10']);
});

test('several jumps with every supported option are kept in order', () => {
  const list = ['ssh -i a -p 2222 -l bob -o StrictHostKeyChecking=yes -o LogLevel=ERROR -J j@h u@b', 'ssh c', 'ssh d', 'ssh e', 'ssh f'];
  assert.deepEqual(validateInventory(withJumps(list)).ssh[0].jumps, list);
});

test('every error names the entry and the field', () => {
  for (const bad of ['ssh u@h', {}, null, 7]) rejects(withJumps(bad), /ssh "app1": jumps: must be a list of 1 to 5 ssh commands/);
  rejects(withJumps([]), /jumps: must be a list of 1 to 5 ssh commands/);
  rejects(withJumps(Array.from({ length: 6 }, () => 'ssh h')), /jumps: must be a list of 1 to 5 ssh commands/);
});

test('an entry that is not a plain command is refused with the tokenizer message', () => {
  rejects(withJumps(['ssh "h"']), /jumps\[0\]: character """ is not allowed/);
  rejects(withJumps(['ssh h; ls']), /jumps\[0\]: character ";" is not allowed/);
  rejects(withJumps(['-i x']), /jumps\[0\]: command may not start with "-"/);
});

test('an entry must start with ssh', () => {
  rejects(withJumps(['scp u@h']), /jumps\[0\]: must start with "ssh"/);
  rejects(withJumps(['ssh h', 'sshx h']), /jumps\[1\]: must start with "ssh"/);
});

test('an unsupported or glued option is named and the supported ones are listed', () => {
  rejects(withJumps(['ssh -A u@h']), /jumps\[0\]: option -A is not supported; the supported options are -i -p -l -o -J, each followed by its value as a separate word; for other settings use -o Key=Value$/);
  rejects(withJumps(['ssh -t u@h']), /option -t is not supported/);
  rejects(withJumps(['ssh -p2222 u@h']), /option -p2222 is not supported/);
  rejects(withJumps(['ssh --help u@h']), /option --help is not supported/);
});

test('an option needs a value that does not start with "-"', () => {
  rejects(withJumps(['ssh -i']), /jumps\[0\]: option -i needs a value/);
  rejects(withJumps(['ssh -i -p 22 u@h']), /the value of -i may not start with "-"/);
  rejects(withJumps(['ssh -o -J u@h']), /the value of -o may not start with "-"/);
});

test('exactly one server must follow the options', () => {
  rejects(withJumps(['ssh']), /jumps\[0\]: needs a server after the options/);
  rejects(withJumps(['ssh -i a']), /needs a server after the options/);
  rejects(withJumps(['ssh u@h uptime']), /nothing may follow the server/);
  rejects(withJumps(['ssh -i a u@h -p 22']), /nothing may follow the server/);
});

test('the server must pass the host check', () => {
  rejects(withJumps(['ssh _x']), /jumps\[0\]: server must match .* \(no leading "-"\)/);
  rejects(withJumps(['ssh /bin/x']), /server must match/);
});

test('a word that starts with "=" is refused', () => {
  const rule = /a word may not start with "=" or contain "==" or ":="$/;
  rejects(withJumps(['ssh =u@h']), /jumps\[0\]: a word may not start with "=" or contain "==" or ":="$/);
  rejects(withJumps(['ssh -i =key u@h']), rule);
  rejects(withJumps(['ssh x==h']), rule);
  rejects(withJumps(['ssh -i a=b:=c u@h']), rule);
});

test('an entry that is not a command says what is expected', () => {
  const message = /ssh "app1": jumps\[1\]: must be an ssh command, for example "ssh -i \.ssh\/key user@server"$/;
  for (const bad of [7, null, {}, '', '   ', ' \t ']) rejects(withJumps(['ssh h', bad]), message);
});

test('a "~" is refused and the reason is given', () => {
  rejects(
    withJumps(['ssh -i ~/.ssh/k u@h']),
    /ssh "app1": jumps\[0\]: "~" is not allowed; a path without a leading "\/" starts in the home folder of that login$/,
  );
});

test('an option that is not a listed setting is refused', () => {
  rejects(withJumps(['ssh -o ProxyCommand=x h']), /jumps\[0\]: the setting ProxyCommand is not supported in a jump; supported: Port User /);
  rejects(withJumps(['ssh -o Port h']), /jumps\[0\]: the value of -o must have the form Key=Value/);
});

test('"any" together with jumps is an inventory error, and "any" without jumps is not', () => {
  rejects(withJumps(['ssh h'], { allow: 'any' }), /ssh "app1": jumps: a target with jumps needs a list of rules, not "any"/);
  assert.equal(validateInventory({ ssh: [{ ...SSH, allow: 'any' }] }).ssh[0].allow, 'any');
});

test('jumps is an unknown key on local and cluster targets', () => {
  rejects({ local: [{ name: 'infra', cwd: '/srv/infra', allow: ['git status'], jumps: ['ssh h'] }] }, /local "infra": unknown key "jumps"/);
  rejects({
    kubernetes: [{
      name: 'lab', kubeconfig: '/k.yaml', proxyPort: 8001, allow: ['get ...'], jumps: ['ssh h'],
    }],
  }, /kubernetes "lab": unknown key "jumps"/);
});

test('a target with jumps may still use review', () => {
  const raw = {
    reviewers: { r: { baseUrl: 'https://api.example.com/v1', model: 'm' } },
    ssh: [{ ...SSH, jumps: ['ssh h'], review: { reviewer: 'r', policy: 'read only' } }],
  };
  assert.equal(validateInventory(raw).ssh[0].review.reviewer, 'r');
});

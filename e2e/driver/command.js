// The command examples of docs/EXAMPLES.md with the stand-in gh of the runner (e2e/images/runner/gh), since a real gh
// needs GitHub. The stand-in adds a line to its record for each run: its words, which token of the run GH_TOKEN held
// (never the token), the names of its environment variables and its working folder. So the record shows that each
// allowed call runs the program once with the token of its target, that a refused call never starts it, and what the
// program gets from ksproxy: a small environment, in an empty folder that is removed afterwards.
import fs from 'node:fs';
import { clip } from './lib.js';

const RECORD = '/home/node/out/gh-calls.jsonl';
// What a command program gets: these variables of start (SERVICES.md, command, "Limits") and the env of its target.
const GIVEN = ['GH_TOKEN', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR'];
// The token that each target names, as the stand-in calls it.
const tokenOf = { 'gh-shop': 'read', 'gh-triage': 'triage' };

const records = () => (fs.existsSync(RECORD)
  ? fs.readFileSync(RECORD, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : []);
const secret = (name) => fs.readFileSync(`/secrets/${name}`, 'utf8').trim();

export async function commandScenario({ checks, agent }) {
  const runs = [];
  const replies = [];
  // One call; gives the answer and the runs of the stand-in that the call made.
  const run = async (target, command) => {
    const before = records().length;
    const answer = await agent.call('command_exec', { target, command });
    replies.push(answer.text);
    return { answer, added: records().slice(before) };
  };
  const allowed = async (target, command, expect, name = `allowed: ${command}`) => {
    const { answer, added } = await run(target, command);
    checks.check(name, !answer.isError && answer.text.startsWith('exit code: 0') && expect(answer.text), clip(answer.text));
    checks.check(
      `gh ran once, with these words and the ${tokenOf[target]} token in GH_TOKEN`,
      added.length === 1 && JSON.stringify(added[0].args) === JSON.stringify(command.split(' ')) && added[0].token === tokenOf[target],
      JSON.stringify(added),
    );
    runs.push(...added);
  };
  // A refusal of ksproxy, with the reason that the docs give for it; the record shows that gh never started.
  const refused = async (target, command, why, reason) => {
    const { answer, added } = await run(target, command);
    checks.check(
      `refused, and gh never started: ${command} (${why})`,
      answer.isError && answer.text.startsWith(`REFUSED (command ${target}): ${reason}`) && added.length === 0,
      `${clip(answer.text)}\nruns of gh: ${JSON.stringify(added)}`,
    );
  };

  checks.begin('command: gh-shop, read only (stand-in gh)');
  await allowed('gh-shop', 'issue list -R example/shop', (text) => text.includes('\n42\tOPEN\tCheckout fails on Safari\t'));
  await allowed('gh-shop', 'issue view 42 -R example/shop', (text) => text.includes('title:\tCheckout fails on Safari'));
  await allowed('gh-shop', 'pr list -R example/shop', (text) => text.includes('\tfix-safari-pay\tOPEN\t'));
  await allowed('gh-shop', 'pr view 7 -R example/shop', (text) => text.includes('title:\tFix the pay button on Safari'));
  await allowed('gh-shop', 'pr checks 7 -R example/shop', (text) => text.includes('build\tpass') && text.includes('test\tpass'));
  await refused('gh-shop', 'issue view 42 -R example/billing', 'the rules name example/shop only', 'not on the allowlist');
  await refused('gh-shop', 'issue list --state all -R example/shop', 'a flag is allowed only where a rule writes it', 'not on the allowlist');
  await refused('gh-shop', 'issue edit 42 --add-label bug -R example/shop', 'gh-shop may only read', 'not on the allowlist');
  await refused('gh-shop', 'issue list -R example/shop; gh auth token', 'shell syntax is never allowed', 'character ";" is not allowed');

  checks.begin('command: gh-triage, may set two labels (stand-in gh)');
  await allowed('gh-triage', 'issue edit 42 --add-label bug -R example/shop', (text) => text.includes('https://github.com/example/shop/issues/42'));
  await allowed('gh-triage', 'issue edit 42 --remove-label needs-info -R example/shop', (text) => text.includes('https://github.com/example/shop/issues/42'));
  await allowed('gh-triage', 'issue view 42 -R example/shop', (text) => text.includes('number:\t42'));
  await refused('gh-triage', 'issue edit 42 --add-label wontfix -R example/shop', 'the pattern names two labels only', 'not on the allowlist');
  await refused('gh-triage', 'issue edit 42 --add-label=bug -R example/shop', 'the pattern writes the flag and its value as two words', 'not on the allowlist');
  await refused('gh-triage', 'pr list -R example/shop', 'no rule of gh-triage names pr', 'not on the allowlist');

  checks.begin('command: what the program got');
  const names = [...new Set(runs.flatMap((r) => r.env))].sort();
  checks.check(
    `every run got only ${GIVEN.join(', ')} from ksproxy`,
    runs.length > 0 && names.every((name) => GIVEN.includes(name)) && runs.every((r) => r.env.includes('GH_TOKEN')),
    names.join(', '),
  );
  checks.check(
    'every run started in its own empty folder under the state folder',
    runs.every((r) => r.entries === 0 && /\/\.ksproxy\/(.+\/)?run\/cmd-[^/]+$/.test(r.cwd)) && new Set(runs.map((r) => r.cwd)).size === runs.length,
    clip(JSON.stringify(runs.map((r) => [r.cwd, r.entries])), 2000),
  );
  const kept = runs.filter((r) => fs.existsSync(r.cwd));
  checks.check('every folder was removed after its run', kept.length === 0, kept.map((r) => r.cwd).join('\n'));
  const tokens = [secret('gh_read_token'), secret('gh_triage_token')];
  checks.check('no reply holds a token', replies.every((text) => tokens.every((token) => !text.includes(token))), 'a reply holds a token');
}

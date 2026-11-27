// The leak check: no secret of the run (/secrets/secrets.json, made by e2e/setup/secrets.sh) appears in any answer,
// the audit log, the session folder or the terminal output of start. The network token appears on the terminal once,
// by design, and nowhere else.
import fs from 'node:fs';
import path from 'node:path';

// The text of every file below dir, each with its path; nothing when dir does not exist.
export function folderText(dir) {
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir, { recursive: true }).map((name) => path.join(dir, String(name)))
    .filter((file) => fs.statSync(file).isFile())
    .map((file) => `${file}\n${fs.readFileSync(file, 'utf8')}`).join('\n');
}

// places: { name: text }. secrets: { name: value }. One check per place.
export function leakChecks(checks, places, secrets, token) {
  for (const [place, text] of Object.entries(places)) {
    const found = Object.entries(secrets).filter(([, value]) => text.includes(value)).map(([name]) => name);
    const tokenSeen = text.includes(token);
    const terminal = place === 'the terminal output of start';
    checks.check(
      `${place}: no secret of the run${terminal ? '' : ', and not the network token'}`,
      found.length === 0 && (terminal || !tokenSeen),
      `found: ${[...found, ...(!terminal && tokenSeen ? ['the network token'] : [])].join(', ')}`,
    );
  }
}

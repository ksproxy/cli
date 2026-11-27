// Writes the secrets of one run as one JSON object, for the leak check of the driver. Arguments: the output file, then
// NAME=FILE pairs. A file in PEM form gives one value per line of its base64 body (the lines that are no marker); any
// other file gives its whole text. Values shorter than 16 characters are left out, so that the check never matches
// ordinary text.
import fs from 'node:fs';

const [out, ...pairs] = process.argv.slice(2);
const values = {};
for (const pair of pairs) {
  const at = pair.indexOf('=');
  const name = pair.slice(0, at);
  const text = fs.readFileSync(pair.slice(at + 1), 'utf8');
  if (!text.includes('-----BEGIN')) {
    values[name] = text.trim();
    continue;
  }
  text.split('\n').filter((line) => !line.startsWith('-----') && line.trim().length >= 16)
    .forEach((line, i) => { values[`${name}, line ${i + 1}`] = line.trim(); });
}
for (const [name, value] of Object.entries(values)) {
  if (value.length < 16) throw new Error(`${name} is shorter than 16 characters`);
}
fs.writeFileSync(out, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });

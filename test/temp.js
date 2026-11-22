import fs from 'node:fs';
import path from 'node:path';

const dirs = [];

process.on('exit', () => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix, root = '/tmp') {
  const dir = fs.mkdtempSync(path.join(root, prefix));
  dirs.push(dir);
  return dir;
}

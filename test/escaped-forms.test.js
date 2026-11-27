import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kindByKey } from '../src/kinds/index.js';
import { jsonBodyForms, jsonForms } from '../src/kinds/shared.js';
import { answerCall } from '../src/tools.js';
import { tempDir } from './temp.js';

// Some clients and services do not print a value as it is: the mysql client in batch mode writes a backslash, a tab, a
// newline and a NUL as a backslash and a letter, and JSON (the reply of mongosh, the body of most HTTP APIs) escapes a
// quote, a backslash and control characters. A secret with such a character, held in a row, a document or a body
// that a call can read, must be hidden in that form too. Every value here is made up.
const root = fs.realpathSync(tempDir('ks-esc-', os.tmpdir()));
fs.mkdirSync(path.join(root, 'st', 'logs'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(root, 'cfg'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(root, 'home'), { recursive: true, mode: 0o700 });
const env = {
  PATH: process.env.PATH,
  HOME: path.join(root, 'home'),
  [['KSPROXY', 'STATE', 'DIR'].join('_')]: path.join(root, 'st'),
  [['KSPROXY', 'CONFIG', 'DIR'].join('_')]: path.join(root, 'cfg'),
};
after(() => fs.rmSync(root, { recursive: true, force: true }));

// One call on the real kind, whose perform is replaced for the call by one that prints what its client would.
async function answerOf(key, target, secrets, input, stdout) {
  const kind = kindByKey(key);
  const { perform } = kind;
  kind.perform = async () => ({ exitCode: 0, stdout, stderr: '' });
  try {
    const answer = await answerCall({
      kind: key, name: target.name, input, timeoutSeconds: 30,
    }, {
      calls: new Map([[`${key}:${target.name}`, { target, secrets }]]),
      session: { targets: [target] },
      env,
      signal: new AbortController().signal,
      review: async () => null,
      stderr: { write() {} },
    });
    return answer.text;
  } finally {
    kind.perform = perform;
  }
}

test('jsonForms: each value as JSON writes it inside a string, only where that differs from every value', () => {
  assert.deepEqual(jsonForms(['plain-value-1', 'say "hi"', 'back\\slash', 'tab\there', 'line\nbreak', 'bell\u0007']), [
    'say \\"hi\\"', 'back\\\\slash', 'tab\\there', 'line\\nbreak', 'bell\\u0007',
  ]);
  assert.deepEqual(jsonForms(['café', '€5', 'a/b', 'a<b>&c']), []);
  assert.deepEqual(jsonForms(['a\\b', 'a\\\\b']), ['a\\\\\\\\b']);
  assert.deepEqual(jsonForms([]), []);
});

test('jsonBodyForms: also a slash as PHP writes it and the signs that Go and Rails escape, each form once', () => {
  assert.deepEqual(jsonBodyForms(['plain-value-1', 'café']), []);
  assert.deepEqual(jsonBodyForms(['say "hi"']), ['say \\"hi\\"']);
  assert.deepEqual(jsonBodyForms(['a/b']), ['a\\/b']);
  assert.deepEqual(jsonBodyForms(['a<b>&c']), ['a\\u003cb\\u003e\\u0026c']);
  assert.deepEqual(jsonBodyForms(['q"/<']), ['q\\"/<', 'q\\"\\/<', 'q\\"/\\u003c']);
  assert.deepEqual(jsonBodyForms(['a/b', 'a\\/b']), ['a\\\\/b', 'a\\\\\\/b']);
  assert.deepEqual(jsonBodyForms([]), []);
});

test('mysql: a password with a backslash, a tab or a newline is hidden as batch mode prints it', async () => {
  const mysql = kindByKey('mysql');
  const target = {
    kind: 'mysql', name: 'crm-db', description: '', allow: ['select name, secret from logins'], host: 'crm-db.example.com', port: 3306, database: 'crm', user: 'agent_ro', passwordEnv: 'CRM_PW', state: 'up',
  };
  const password = 'Pw\\x7\tQ9\nz!';
  // The value as batch mode prints it, then the value inside a JSON text as batch mode prints that.
  assert.deepEqual(mysql.hiddenForms(target, { CRM_PW: password }), ['Pw\\\\x7\\tQ9\\nz!', 'Pw\\\\\\\\x7\\\\tQ9\\\\nz!']);
  assert.deepEqual(mysql.hiddenForms(target, { CRM_PW: 'nul\u0000in-it' }), ['nul\\0in-it', 'nul\\\\u0000in-it']);
  assert.deepEqual(mysql.hiddenForms(target, { CRM_PW: 'plain-Pw-1234' }), []);
  const text = await answerOf('mysql', target, { CRM_PW: password }, 'select name, secret from logins', 'name\tsecret\nsvc\tPw\\\\x7\\tQ9\\nz!\nother\tnone\n');
  assert.equal(text, 'exit code: 0\n--- stdout ---\nname\tsecret\nsvc\t[hidden]\nother\tnone');
  // In a JSON text that a row holds, the server writes the quote escaped, and the client then doubles the backslash.
  const quoted = 'Pa"ss-UNMISTAKABLE';
  assert.deepEqual(mysql.hiddenForms(target, { CRM_PW: quoted }), ['Pa\\\\"ss-UNMISTAKABLE']);
  const inJson = await answerOf('mysql', target, { CRM_PW: quoted }, 'select name, secret from logins', 'settings\n{"db_password": "Pa\\\\"ss-UNMISTAKABLE"}\n');
  assert.equal(inJson, 'exit code: 0\n--- stdout ---\nsettings\n{"db_password": "[hidden]"}');
});

test('postgres: a password in a json, jsonb or array value is hidden as the server writes it', async () => {
  const postgres = kindByKey('postgres');
  const target = {
    kind: 'postgres', name: 'shop-db', description: '', allow: ['select settings from apps'], host: 'db1.example.com', port: 5432, database: 'shop', user: 'agent_ro', passwordEnv: 'SHOP_PW', state: 'up',
  };
  const password = 'Pa"ss\\UNMISTAKABLE';
  assert.deepEqual(postgres.hiddenForms(target, { SHOP_PW: password }), ['Pa\\"ss\\\\UNMISTAKABLE']);
  // psql prints a text value as it is: a password without such a character has no other form.
  assert.deepEqual(postgres.hiddenForms(target, { SHOP_PW: 'plain-Pw-1234' }), []);
  const rows = `settings\n{"pw": "Pa\\"ss\\\\UNMISTAKABLE"}\n{"Pa\\"ss\\\\UNMISTAKABLE",other}\n${password}\n`;
  const text = await answerOf('postgres', target, { SHOP_PW: password }, 'select settings from apps', rows);
  assert.equal(text, 'exit code: 0\n--- stdout ---\nsettings\n{"pw": "[hidden]"}\n{"[hidden]",other}\n[hidden]');
});

test('mongodb: a password with a quote or a backslash is hidden as extended JSON prints it', async () => {
  const mongodb = kindByKey('mongodb');
  const target = {
    kind: 'mongodb', name: 'orders', description: '', allow: ['find *'], database: 'shop', uriEnv: 'MGO', writes: false, joins: false, state: 'up',
  };
  const uri = 'mongodb://report:p%22a%5Cs-UNMISTAKABLE@db1.example.com:27017/?authSource=admin';
  const decoded = 'p"a\\s-UNMISTAKABLE';
  const forms = mongodb.hiddenForms(target, { MGO: uri });
  assert.deepEqual(forms, ['p%22a%5Cs-UNMISTAKABLE', decoded, 'p\\"a\\\\s-UNMISTAKABLE']);
  assert.deepEqual(mongodb.hiddenForms(target, { MGO: 'mongodb://report:plain-Pw-1234@db1.example.com/' }), ['plain-Pw-1234', 'plain-Pw-1234']);
  const reply = `${JSON.stringify({ cursor: { firstBatch: [{ user: 'report', note: decoded }] }, ok: 1 }, null, 2)}\n`;
  assert.ok(reply.includes('p\\"a\\\\s-UNMISTAKABLE'));
  const text = await answerOf('mongodb', target, { MGO: uri }, { command: { find: 'logins' } }, reply);
  assert.ok(text.includes('"note": "[hidden]"'), text);
  assert.ok(!text.includes('UNMISTAKABLE'));
});

test('http, elasticsearch and rabbitmq: a secret with a quote or a backslash is hidden in a JSON body', async () => {
  const token = 'tok"en\\UNMISTAKABLE';
  const body = JSON.stringify({ headers: { authorization: `Bearer ${token}` }, password: 'pa"ss\\UNMISTAKABLE' });
  const http = {
    kind: 'http', name: 'echo', description: '', allow: ['GET /echo'], baseUrl: 'https://api.example.com/', auth: { bearerEnv: 'T' }, state: 'up',
  };
  assert.deepEqual(kindByKey('http').hiddenForms(http, { T: token }), ['tok\\"en\\\\UNMISTAKABLE']);
  assert.deepEqual(kindByKey('http').hiddenForms(http, { T: 'plain-token-1234' }), []);
  const shown = await answerOf('http', http, { T: token }, { method: 'GET', path: '/echo' }, `HTTP 200\ncontent-type: application/json\n\n${body}`);
  assert.equal(shown, 'exit code: 0\n--- stdout ---\nHTTP 200\ncontent-type: application/json\n\n{"headers":{"authorization":"Bearer [hidden]"},"password":"pa\\"ss\\\\UNMISTAKABLE"}');
  // Basic auth: the base64 credential as before, then the user name and the password as JSON writes them.
  const secrets = { U: 'ops"user', P: 'pa"ss\\UNMISTAKABLE' };
  const basic = Buffer.from(`${secrets.U}:${secrets.P}`).toString('base64');
  for (const key of ['elasticsearch', 'rabbitmq']) {
    const target = {
      kind: key, name: 'svc', description: '', allow: ['GET /api/overview'], baseUrl: 'https://svc.example.com/', auth: { basicUserEnv: 'U', basicPasswordEnv: 'P' }, state: 'up',
    };
    assert.deepEqual(kindByKey(key).hiddenForms(target, secrets), [basic, 'ops\\"user', 'pa\\"ss\\\\UNMISTAKABLE'], key);
    const text = await answerOf(key, target, secrets, { method: 'GET', path: '/api/overview' }, `HTTP 200\ncontent-type: application/json\n\n${body}`);
    assert.ok(text.endsWith('"password":"[hidden]"}'), `${key}: ${text.slice(0, 200)}`);
  }
  // A base64 credential with a slash, which a service written in PHP echoes with a backslash before it.
  const slash = { U: 'ops', P: 'x?>pw-UNMISTAKABLE' };
  const credential = Buffer.from(`${slash.U}:${slash.P}`).toString('base64');
  assert.ok(credential.includes('/'));
  const es = {
    kind: 'elasticsearch', name: 'svc', description: '', allow: ['GET /*'], baseUrl: 'https://svc.example.com/', auth: { basicUserEnv: 'U', basicPasswordEnv: 'P' }, state: 'up',
  };
  assert.deepEqual(kindByKey('elasticsearch').hiddenForms(es, slash), [credential, 'x?\\u003epw-UNMISTAKABLE', credential.replaceAll('/', '\\/')]);
});

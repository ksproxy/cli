import test from 'node:test';
import assert from 'node:assert/strict';
import { readSecrets } from '../src/start.js';
import { kindByKey } from '../src/kinds/index.js';

// The short-secret warning of start: which sources it names, from the values and from the forms a kind hides.
const held = (entries) => new Map(Object.entries(entries));
const LONG = 'a-long-enough-secret';

test('a short value that is only a user name gives no warning; a short password does', () => {
  const redis = kindByKey('redis');
  const target = { userEnv: 'R_USER', passwordEnv: 'R_PASS' };
  assert.deepEqual(redis.secrets(target), { env: ['R_USER', 'R_PASS'], files: [], users: ['R_USER'] });
  assert.deepEqual(readSecrets(redis, target, held({ R_USER: 'bob', R_PASS: LONG })).short, []);
  assert.deepEqual(readSecrets(redis, target, held({ R_USER: 'bob', R_PASS: 'pw' })).short, ['R_PASS']);

  const http = kindByKey('http');
  const basic = { auth: { basicUserEnv: 'H_USER', basicPasswordEnv: 'H_PASS' } };
  assert.deepEqual(http.secrets(basic), { env: ['H_USER', 'H_PASS'], files: [], users: ['H_USER'] });
  assert.deepEqual(http.secrets({ auth: { bearerEnv: 'H_TOK' } }), { env: ['H_TOK'], files: [] });
  assert.deepEqual(readSecrets(http, basic, held({ H_USER: 'ann', H_PASS: LONG })).short, []);

  const elastic = kindByKey('elasticsearch');
  const esBasic = { auth: { basicUserEnv: 'E_USER', basicPasswordEnv: 'E_PASS' } };
  assert.deepEqual(elastic.secrets(esBasic), { env: ['E_USER', 'E_PASS'], files: [], users: ['E_USER'] });
  assert.deepEqual(readSecrets(elastic, esBasic, held({ E_USER: 'ann', E_PASS: LONG })).short, []);
});

test('a hidden form shorter than 8 characters names the variable it came from, once, never a user name', () => {
  const mongodb = kindByKey('mongodb');
  const target = { uriEnv: 'M_URI' };
  const decoded = readSecrets(mongodb, target, held({ M_URI: 'mongodb://reporting:%41bc@db.example.com/shop' }));
  assert.deepEqual(decoded.short, []);
  assert.deepEqual(decoded.shortForms, ['M_URI']);
  assert.deepEqual(readSecrets(mongodb, target, held({ M_URI: `mongodb://reporting:${LONG}@db.example.com/shop` })).shortForms, []);

  const http = kindByKey('http');
  const basic = { auth: { basicUserEnv: 'H_USER', basicPasswordEnv: 'H_PASS' } };
  const both = readSecrets(http, basic, held({ H_USER: 'a', H_PASS: 'b' }));
  assert.deepEqual([both.short, both.shortForms], [['H_PASS'], []], 'the base64 of a:b is short, and the password is named once');

  const redis = kindByKey('redis');
  const userOnly = readSecrets(redis, { userEnv: 'R_USER', passwordEnv: 'R_PASS' }, held({ R_USER: 'bob', R_PASS: LONG }));
  assert.deepEqual(userOnly.shortForms, [], 'the escaped form of a short user name');
  const short = readSecrets(redis, { userEnv: null, passwordEnv: 'R_PASS' }, held({ R_PASS: 'pw' }));
  assert.deepEqual([short.short, short.shortForms], [['R_PASS'], []], 'a short value is named once');
});

test('a kind whose hiddenForms throws, or has none, gives no form warning', () => {
  const base = {
    secrets: () => ({ env: ['K'], files: [] }),
  };
  assert.deepEqual(readSecrets(base, {}, held({ K: LONG })).shortForms, []);
  const throwing = { ...base, hiddenForms: () => { throw new Error('no forms'); } };
  assert.deepEqual(readSecrets(throwing, {}, held({ K: LONG })).shortForms, []);
  const empty = { ...base, hiddenForms: () => ['', LONG] };
  assert.deepEqual(readSecrets(empty, {}, held({ K: LONG })).shortForms, []);
});

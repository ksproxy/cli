import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { handleMessage, serve } from '../src/mcp.js';

test('an error raised while handling a request becomes an internal error response', async () => {
  const request = {
    jsonrpc: '2.0',
    id: 5,
    method: 'initialize',
    params: { get protocolVersion() { throw new Error('boom'); } },
  };
  assert.deepEqual(await handleMessage(request), {
    jsonrpc: '2.0', id: 5, error: { code: -32603, message: 'Internal error: boom' },
  });
});

test('a value that is not an Error is reported as it is', async () => {
  const request = {
    jsonrpc: '2.0',
    id: 'a',
    method: 'tools/call',
    params: { get arguments() { throw 'plain text failure'; } },
  };
  assert.deepEqual(await handleMessage(request), {
    jsonrpc: '2.0', id: 'a', error: { code: -32603, message: 'Internal error: plain text failure' },
  });
});

test('serve skips blank lines, answers bad JSON with a parse error and keeps going', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => { written += chunk; });
  const done = serve({ input, output, env: {} });
  input.write('\n   \n');
  input.write('{not json\n');
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  input.end();
  await done;
  const lines = written.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, [
    { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    { jsonrpc: '2.0', id: 1, result: {} },
  ]);
});

test('tools/call arguments must be an object when present', async () => {
  for (const args of [[], null, 'text', 5]) {
    const response = await handleMessage({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_targets', arguments: args },
    });
    assert.deepEqual(response, { jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'Invalid params' } }, JSON.stringify(args));
  }
  const ok = await handleMessage({
    jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} },
  });
  assert.deepEqual(ok, {
    jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'unknown tool: no_such_tool' }], isError: true },
  });
});

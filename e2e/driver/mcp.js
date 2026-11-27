// The mcp examples of docs/EXAMPLES.md with @modelcontextprotocol/server-everything in place of the Jira server:
// two local servers over stdio, started by a pinned npx from its cache, and one remote server over Streamable HTTP with
// https and a bearer token (e2e/setup/mcp-remote.js). The allowed tools appear in the agent's own list as TARGET__TOOL.
import { clip } from './lib.js';

// The variables that start has and that no local server may get (see "The server's environment" in
// docs/MCP-SERVERS.md).
const START_ONLY = ['SHOP_DB_PASSWORD', 'SHOP_DB_RW_PASSWORD', 'EVERYTHING_TOKEN', 'NODE_EXTRA_CA_CERTS'];

export async function mcpScenario({ checks, agent, tools }) {
  const names = tools.map((tool) => tool.name);
  const refusedText = (target, reason) => `REFUSED (mcp ${target}): ${reason}`;

  checks.begin('mcp: the agent\'s tool list');
  const exported = [
    'everything__echo', 'everything__get-sum', 'everything-rw__get-sum', 'everything-rw__get-env', 'everything-rw__echo',
    'everything-net__echo', 'everything-net__get-sum',
  ];
  checks.check('every allowed tool is listed as TARGET__TOOL', exported.every((name) => names.includes(name)),
    `missing: ${exported.filter((name) => !names.includes(name)).join(', ')}`);
  const hidden = names.filter((name) => /^everything(-rw|-net)?__/.test(name) && !exported.includes(name));
  checks.check('no other tool of the servers is listed', hidden.length === 0, hidden.join(', '));
  const echo = tools.find((tool) => tool.name === 'everything__echo');
  checks.check('a description says where it comes from', echo?.description?.startsWith('[from the MCP server "everything"]'), echo?.description);
  checks.check('ksproxy\'s own tools come first', names[0] === 'list_targets' && names.includes('ssh_exec') && names.includes('postgres_query'), names.slice(0, 5).join(', '));

  checks.begin('mcp: everything, local, read only');
  const said = await agent.call('everything__echo', { message: 'hello from the e2e run' });
  checks.check('allowed: echo', !said.isError && said.text.includes('hello from the e2e run'), clip(said.text));
  const sum = await agent.call('everything__get-sum', { a: 2, b: 40 });
  checks.check('allowed: get-sum', !sum.isError && sum.text.includes('42'), clip(sum.text));
  const env = await agent.call('everything__get-env', {});
  checks.check('refused: everything__get-env, which is not listed', env.isError && env.text === 'unknown tool: everything__get-env', clip(env.text));
  const viaCall = await agent.call('mcp_call', { target: 'everything', tool: 'get-env', arguments: {} });
  checks.check('refused: get-env through mcp_call', viaCall.isError && viaCall.text.startsWith(refusedText('everything', 'no rule allows get-env')), clip(viaCall.text));

  checks.begin('mcp: everything-rw, local, echo of SHOP messages only');
  const shop = await agent.call('everything-rw__echo', { message: 'SHOP-42 Fixed in build 512' });
  checks.check('allowed: echo of SHOP-42', !shop.isError && shop.text.includes('SHOP-42 Fixed in build 512'), clip(shop.text));
  const hr = await agent.call('everything-rw__echo', { message: 'HR-7 Done' });
  checks.check('refused: echo of HR-7 (the pattern allows SHOP- only)', hr.isError && hr.text.startsWith(refusedText('everything-rw', 'no rule allows echo with these arguments')), clip(hr.text));
  const seen = await agent.call('everything-rw__get-env', {});
  let vars = {};
  try {
    vars = JSON.parse(seen.text.slice(seen.text.indexOf('--- stdout ---\n') + '--- stdout ---\n'.length));
  } catch {
    // checked below
  }
  checks.check('allowed: get-env', !seen.isError && typeof vars.PATH === 'string', clip(seen.text));
  checks.check('the server gets the env of its entry', vars.SHOP_REGION === 'e2e' && vars.npm_config_offline === 'true', clip(seen.text));
  const leaked = START_ONLY.filter((name) => Object.hasOwn(vars, name));
  checks.check('no variable of start reaches the server', leaked.length === 0, leaked.join(', '));

  checks.begin('mcp: everything-net, remote, https and a bearer token');
  const far = await agent.call('everything-net__echo', { message: 'over https' });
  checks.check('allowed: echo', !far.isError && far.text.includes('over https'), clip(far.text));
  const farSum = await agent.call('everything-net__get-sum', { a: 20, b: 22 });
  checks.check('allowed: get-sum', !farSum.isError && farSum.text.includes('42'), clip(farSum.text));
  const farEnv = await agent.call('mcp_call', { target: 'everything-net', tool: 'get-env', arguments: {} });
  checks.check('refused: get-env (the tool is not on the list)', farEnv.isError && farEnv.text.startsWith(refusedText('everything-net', 'no rule allows get-env')), clip(farEnv.text));
}

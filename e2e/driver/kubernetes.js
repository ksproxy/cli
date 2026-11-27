// The kubernetes examples of docs/EXAMPLES.md against k3s (e2e/images/k3s), one server node with the namespace shop and
// the deployment web (redis:7-alpine). The targets lab and lab-deploy are the entries of the examples word for word.
// Each kubeconfig (~/.kube/lab-viewer.yaml and ~/.kube/lab-deployer.yaml) holds a token of this run for a
// ServiceAccount of shop and the CA of the cluster; ksproxy start runs kubectl proxy with it, and the agent's kubectl
// talks to that proxy only. The API server records every request of the two identities, with its body, and every
// request without a valid identity, in its audit log (e2e/images/k3s/audit-policy.yaml). So the log shows which calls
// reached it and as whom, and that no refused call did. kubectl is k3s's own (e2e/images/runner/Dockerfile).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  clip, logChecks, processes, stdoutOf, waitFor,
} from './lib.js';

const FROM = '/kube';
export const AUDIT_LOG = '/k3slog/audit.log';
// The ServiceAccount of shop behind each target, and the port of its kubectl proxy (inventory.js).
const IDENTITY = { lab: 'lab-viewer', 'lab-deploy': 'lab-deployer' };
const PROXY_PORT = { lab: 8001, 'lab-deploy': 8002 };
const NO_RULE = 'not on the allowlist';
const NOT_HERE = (verb) => `the "${verb}" command is not available through this proxy`;
const NO_FLAG = (flag) => `the flag ${flag} is not available through this proxy`;
const NO_SECRET = 'secret resources are never allowed';

// Puts the kubeconfigs of the run where the examples keep them, in ~/.kube, as the owner would. Gives their tokens,
// and the signature of each (the part of the token that only the cluster can make), as secrets of the run.
export function installKubeconfigs() {
  const dir = path.join(os.homedir(), '.kube');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secrets = {};
  for (const name of Object.values(IDENTITY)) {
    const text = fs.readFileSync(path.join(FROM, `${name}.yaml`), 'utf8');
    fs.writeFileSync(path.join(dir, `${name}.yaml`), text, { mode: 0o600 });
    const token = /^ +token: (\S+)$/m.exec(text)?.[1];
    if (token === undefined || token.split('.').length !== 3) throw new Error(`no token in ${FROM}/${name}.yaml`);
    secrets[`${name} token`] = token;
    secrets[`${name} token signature`] = token.split('.')[2];
  }
  return secrets;
}

// The entries of the audit log text; a line that is not JSON is skipped.
const entriesOf = (text) => text.split('\n').filter(Boolean).flatMap((line) => {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
});
// A marker for logChecks: the log has it when one of its entries passes test.
const entry = (test) => ({ test: (text) => entriesOf(text).some(test) });
const by = (target) => (e) => e.user?.username === `system:serviceaccount:shop:${IDENTITY[target]}`;
const ref = (e) => e.objectRef ?? {};
const code = (e) => e.responseStatus?.code;
// A request of target to exactly this URI, answered with status.
const uri = (target, requestURI, status = 200) => entry((e) => by(target)(e) && e.requestURI === requestURI && code(e) === status);
// A request that sets the scale of a deployment to replicas.
const scaleTo = (replicas) => (e) => ref(e).resource === 'deployments' && ref(e).subresource === 'scale'
  && ['patch', 'update'].includes(e.verb) && e.requestObject?.spec?.replicas === replicas;
// The scale of web set to replicas by lab-deploy, and done.
const scaled = (replicas) => entry((e) => by('lab-deploy')(e) && ref(e).name === 'web' && code(e) === 200 && scaleTo(replicas)(e));
// A request whose URI names this path, by anyone.
const named = (part) => entry((e) => String(e.requestURI).includes(part));

// One request to the kubectl proxy of a target, from this container, as any program here could send it: { status, text }.
function proxyRequest(target, method, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PROXY_PORT[target], method, path: requestPath, timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`no answer from the proxy of ${target} within 30 s`)));
    req.on('error', reject);
    req.end();
  });
}

export async function kubernetesScenario({ checks, agent }) {
  const reached = [];
  const kept = [];
  const run = (cluster, args, timeout = 60) => agent.call('kubectl', { cluster, args, timeout_seconds: timeout });
  const allowed = async (cluster, args, expect, name = `allowed: ${args.join(' ')}`, timeout = 60) => {
    const answer = await run(cluster, args, timeout);
    checks.check(name, !answer.isError && answer.text.startsWith('exit code: 0') && expect(stdoutOf(answer.text)), clip(answer.text, 1500));
    return answer;
  };
  // A refusal of ksproxy, with the reason that the docs give for it. marker: what the call would leave in the log.
  const refused = async (cluster, args, why, reason, marker) => {
    const answer = await run(cluster, args);
    checks.check(`refused: ${args.join(' ')} (${why})`, answer.isError && answer.text.startsWith(`REFUSED (kube ${cluster}): ${reason}`), clip(answer.text));
    if (marker !== undefined) kept.push({ name: `${args.join(' ')} (${cluster})`, marker });
  };
  // The pods of web that run and are ready, not those that stop: their names, as lab-deploy reads them.
  const readyPods = async () => {
    const answer = await run('lab-deploy', ['get', 'pods', '-n', 'shop', '-l', 'app=web', '-o', 'json']);
    let items = [];
    try {
      items = JSON.parse(stdoutOf(answer.text)).items;
    } catch {
      checks.check('get pods -n shop -l app=web -o json gives the pods as JSON', false, clip(answer.text));
    }
    return items.filter((pod) => pod.metadata.deletionTimestamp === undefined
      && (pod.status.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True')).map((pod) => pod.metadata.name);
  };

  checks.begin('kubernetes: the kubectl proxies of start');
  // start runs kubectl proxy once per target, on the loopback address of its port. k3s's kubectl shows only its name
  // in the process list (it hides its arguments), so the processes are counted, and each port is tried.
  const proxies = processes().filter((cmd) => /^(\S*\/)?kubectl\b/.test(cmd));
  checks.check(`start runs ${Object.keys(IDENTITY).length} kubectl processes, one proxy per target`,
    proxies.length === Object.keys(IDENTITY).length, proxies.join('\n'));
  for (const target of Object.keys(IDENTITY)) {
    const version = await proxyRequest(target, 'GET', '/version').catch((err) => ({ status: 0, text: err.message }));
    checks.check(`the proxy of ${target} answers on 127.0.0.1:${PROXY_PORT[target]}`, version.status === 200 && version.text.includes('"gitVersion"'),
      `${version.status} ${clip(version.text)}`);
  }

  checks.begin('kubernetes: lab, read only (lab-viewer, the role view in shop)');
  await allowed('lab', ['get', 'pods', '-n', 'shop'], (out) => /^web-\S+ +1\/1 +Running /m.test(out));
  reached.push({ name: 'get pods -n shop (lab)', marker: uri('lab', '/api/v1/namespaces/shop/pods?limit=500') });
  await allowed('lab', ['describe', 'deployment', 'web', '-n', 'shop'],
    (out) => /^Namespace: +shop$/m.test(out) && /^ +Image: +redis:7-alpine$/m.test(out));
  reached.push({ name: 'describe deployment web -n shop (lab)', marker: uri('lab', '/apis/apps/v1/namespaces/shop/deployments/web') });
  await allowed('lab', ['logs', 'deploy/web', '-n', 'shop', '--tail', '200'], (out) => out.includes('Ready to accept connections'),
    'allowed: logs deploy/web -n shop --tail 200, which shows the log of redis');
  reached.push({
    name: 'logs deploy/web -n shop --tail 200 (lab)',
    marker: entry((e) => by('lab')(e) && /^\/api\/v1\/namespaces\/shop\/pods\/web-[^/]+\/log\?.*tailLines=200/.test(e.requestURI)),
  });
  // The seed of the cluster waited until metrics-server had the usage of these pods (see e2e/images/k3s/seed.sh).
  await allowed('lab', ['top', 'pods', '-n', 'shop'], (out) => /^web-\S+ +\d+m +\d+Mi/m.test(out),
    'allowed: top pods -n shop, with the usage that metrics-server measured');
  reached.push({ name: 'top pods -n shop (lab)', marker: uri('lab', '/apis/metrics.k8s.io/v1beta1/namespaces/shop/pods') });
  // k3s imported redis:7-alpine at start, so the kubelet never pulled it.
  await allowed('lab', ['events', '-n', 'shop'], (out) => out.includes('Scaled up replica set web-') && out.includes('Started')
    && out.includes('Container image "redis:7-alpine" already present on machine') && !out.includes('Pulling'),
  'allowed: events -n shop, which show that redis:7-alpine was already on the node and never pulled');
  reached.push({ name: 'events -n shop (lab)', marker: entry((e) => by('lab')(e) && e.verb === 'list' && ref(e).resource === 'events' && ref(e).namespace === 'shop') });
  // The rule get ... lets the call through; the role view is bound in shop only, so the API server refuses it.
  const system = await run('lab', ['get', 'pods', '-n', 'kube-system']);
  checks.check(
    'the API server refuses get pods -n kube-system (403): lab-viewer may read shop only',
    system.isError && system.text.startsWith('exit code: 1') && system.text.includes('Error from server (Forbidden)')
      && system.text.includes('"system:serviceaccount:shop:lab-viewer" cannot list resource "pods"'),
    clip(system.text),
  );
  reached.push({ name: 'get pods -n kube-system, refused by RBAC (lab)', marker: uri('lab', '/api/v1/namespaces/kube-system/pods?limit=500', 403) });
  await refused('lab', ['get', 'secret', 'db-password', '-n', 'shop'], 'secret resources are never allowed', NO_SECRET);
  await refused('lab', ['get', 'pods,secrets', '-n', 'shop'], 'a list of resources with secrets in it', NO_SECRET);
  await refused('lab', ['delete', 'pod', 'web-7d9c', '-n', 'shop'], 'no rule allows delete', NO_RULE, named('/pods/web-7d9c'));
  await refused('lab', ['rollout', 'restart', 'deployment/web', '-n', 'shop'], 'lab may only read', NO_RULE,
    entry((e) => by('lab')(e) && e.verb === 'patch'));
  await refused('lab', ['exec', 'exec-check', '-n', 'shop', '--', 'redis-cli', 'info'], 'exec is never available', NOT_HERE('exec'),
    named('/pods/exec-check'));
  await refused('lab', ['port-forward', 'pod/pf-check', '16379:6379', '-n', 'shop'], 'port-forward is never available',
    NOT_HERE('port-forward'), named('/pods/pf-check'));
  await refused('lab', ['cp', 'shop/cp-check:/data/dump.rdb', '/tmp/dump.rdb'], 'cp is never available', NOT_HERE('cp'),
    named('/pods/cp-check'));
  await refused('lab', ['get', 'pod', 'kubeconfig-check', '-n', 'shop', '--kubeconfig', path.join(os.homedir(), '.kube', 'lab-deployer.yaml')],
    'the identity is fixed', NO_FLAG('--kubeconfig'), named('/pods/kubeconfig-check'));
  await refused('lab', ['get', 'pod', 'context-check', '-n', 'shop', '--context', 'lab-deploy'], 'the identity is fixed',
    NO_FLAG('--context'), named('/pods/context-check'));
  await refused('lab', ['get', 'pod', 'token-check', '-n', 'shop', '--token=made-up-token'], 'the identity is fixed',
    NO_FLAG('--token'), named('/pods/token-check'));

  checks.begin('kubernetes: lab-deploy, may restart and scale shop/web (lab-deployer)');
  await allowed('lab-deploy', ['get', 'deployment', 'web', '-n', 'shop'], (out) => /^web +1\/1 +1 +1 /m.test(out));
  const before = await readyPods();
  checks.check('one pod of web runs before the restart', before.length === 1, JSON.stringify(before));
  await allowed('lab-deploy', ['rollout', 'restart', 'deployment/web', '-n', 'shop'], (out) => out.includes('deployment.apps/web restarted'));
  reached.push({
    name: 'rollout restart deployment/web -n shop (lab-deploy)',
    marker: entry((e) => by('lab-deploy')(e) && e.verb === 'patch' && ref(e).resource === 'deployments' && ref(e).name === 'web'
      && ref(e).subresource === undefined && code(e) === 200 && JSON.stringify(e.requestObject).includes('kubectl.kubernetes.io/restartedAt')),
  });
  await allowed('lab-deploy', ['rollout', 'status', 'deployment/web', '-n', 'shop'], (out) => out.includes('successfully rolled out'),
    'allowed: rollout status deployment/web -n shop, until the restart is done', 120);
  reached.push({ name: 'rollout status deployment/web -n shop (lab-deploy)', marker: entry((e) => by('lab-deploy')(e) && e.verb === 'watch' && ref(e).resource === 'deployments') });
  const restarted = await readyPods();
  checks.check('the restart made a new pod, which runs in place of the old one', restarted.length === 1 && !before.includes(restarted[0]),
    `before: ${JSON.stringify(before)}, after: ${JSON.stringify(restarted)}`);

  await allowed('lab-deploy', ['scale', 'deployment/web', '--replicas=3', '-n', 'shop'], (out) => out.includes('deployment.apps/web scaled'));
  reached.push({ name: 'scale deployment/web --replicas=3 -n shop (lab-deploy)', marker: scaled(3) });
  await allowed('lab-deploy', ['rollout', 'status', 'deployment/web', '-n', 'shop'], (out) => out.includes('successfully rolled out'),
    'allowed: rollout status deployment/web -n shop, until 3 pods are ready', 120);
  const three = await readyPods();
  checks.check('3 pods of web run and are ready', three.length === 3, JSON.stringify(three));
  await allowed('lab-deploy', ['scale', 'deployment/web', '--replicas=1', '-n', 'shop'], (out) => out.includes('deployment.apps/web scaled'));
  reached.push({ name: 'scale deployment/web --replicas=1 -n shop (lab-deploy)', marker: scaled(1) });
  await allowed('lab-deploy', ['rollout', 'status', 'deployment/web', '-n', 'shop'], (out) => out.includes('successfully rolled out'),
    'allowed: rollout status deployment/web -n shop', 120);
  // rollout status can end before the 2 pods stop: it waits for a rollout, not for a scale down. So the run waits,
  // with a deadline, until the deployment counts 1 pod that is not stopping, and 1 ready.
  const replicas = ['get', 'deployment', 'web', '-n', 'shop', '-o', 'jsonpath={.spec.replicas} {.status.replicas} {.status.readyReplicas}'];
  const counted = await waitFor(async () => {
    const out = stdoutOf((await run('lab-deploy', replicas)).text).trim();
    return out === '1 1 1' ? out : null;
  }, { ms: 60000, everyMs: 1000, what: 'web to count 1 pod' }).catch((err) => err.message);
  checks.check('web wants 1 pod, has 1 and 1 is ready', counted === '1 1 1', counted);
  const one = await readyPods();
  checks.check('1 pod of web runs, one of the 3', one.length === 1 && three.includes(one[0]), `${JSON.stringify(three)} -> ${JSON.stringify(one)}`);

  await refused('lab-deploy', ['scale', 'deployment/web', '--replicas=20', '-n', 'shop'], 'the pattern allows 1 to 5 replicas only', NO_RULE, entry(scaleTo(20)));
  await refused('lab-deploy', ['scale', 'deployment/web', '--replicas=6', '-n', 'shop'], 'the pattern allows 1 to 5 replicas only', NO_RULE, entry(scaleTo(6)));
  await refused('lab-deploy', ['scale', 'deployment/web', '--replicas=0', '-n', 'shop'], 'the pattern allows 1 to 5 replicas only', NO_RULE, entry(scaleTo(0)));
  await refused('lab-deploy', ['scale', '-n', 'shop', 'deployment/web', '--replicas=3'], 'a rule is matched word by word, -n shop at the end', NO_RULE);
  await refused('lab-deploy', ['rollout', 'restart', 'deployment/api', '-n', 'shop'], 'the rules name web only', NO_RULE, named('/deployments/api'));
  await refused('lab-deploy', ['delete', 'deployment', 'web', '-n', 'shop'], 'no rule allows delete', NO_RULE, entry((e) => e.verb === 'delete'));
  await refused('lab-deploy', ['create', 'token', 'lab-deployer', '-n', 'shop'], 'create token is never allowed',
    '"create token" is never allowed: it would hand out a credential', entry((e) => ref(e).resource === 'serviceaccounts' && ref(e).subresource === 'token'));
  await allowed('lab-deploy', ['get', 'deployment', 'web', '-n', 'shop', '-o', 'jsonpath={.spec.replicas}'], (out) => out.trim() === '1',
    'the refused calls changed nothing: web still wants 1 pod');

  // kubectl proxy is the second lock (docs/RULES.md): it refuses these paths itself, whatever a program on this machine
  // sends it. The answer of the API server would be JSON; the proxy's is the word Forbidden.
  checks.begin('kubernetes: the second lock, kubectl proxy');
  const pod = one[0] ?? 'web';
  const lock = [
    ['GET', '/api/v1/namespaces/shop/secrets', 'secrets'],
    ['POST', `/api/v1/namespaces/shop/pods/${pod}/exec?command=true&stdout=true`, 'pod exec'],
    ['POST', `/api/v1/namespaces/shop/pods/${pod}/attach?stdout=true`, 'pod attach'],
    ['POST', `/api/v1/namespaces/shop/pods/${pod}/portforward?ports=6379`, 'pod port-forward'],
    ['POST', '/api/v1/namespaces/shop/serviceaccounts/lab-viewer/token', 'service account tokens'],
  ];
  for (const [method, requestPath, what] of lock) {
    const answer = await proxyRequest('lab', method, requestPath).catch((err) => ({ status: 0, text: err.message }));
    checks.check(`the proxy of lab refuses ${what}: ${method} ${requestPath.split('?')[0]}`, answer.status === 403 && answer.text.trim() === 'Forbidden',
      `${answer.status} ${clip(answer.text)}`);
  }
  kept.push({ name: 'the proxy paths for pod exec, attach and port-forward', marker: entry((e) => ['exec', 'attach', 'portforward'].includes(ref(e).subresource)) });
  kept.push({ name: 'any secret, by any call', marker: entry((e) => ref(e).resource === 'secrets') });
  const pods = await proxyRequest('lab', 'GET', '/api/v1/namespaces/shop/pods').catch((err) => ({ status: 0, text: err.message }));
  checks.check('the proxy of lab passes GET /api/v1/namespaces/shop/pods on to the API server', pods.status === 200 && pods.text.includes('"kind":"PodList"'),
    `${pods.status} ${clip(pods.text)}`);

  checks.begin('kubernetes: the audit log of the API server');
  const text = await logChecks(checks, {
    file: AUDIT_LOG, reached, kept, noun: 'call',
  });
  const entries = entriesOf(text);
  const users = [...new Set(entries.map((e) => e.user?.username))].sort();
  checks.check(
    'every request came from lab-viewer or lab-deployer: none came without a valid identity',
    entries.length > 0 && users.every((name) => Object.values(IDENTITY).some((id) => name === `system:serviceaccount:shop:${id}`)),
    users.join(', '),
  );
}

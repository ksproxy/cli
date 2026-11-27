import path from 'node:path';
import { decide, describeAllow } from '../../allowlist.js';
import {
  InventoryError, absolutePath, checkAllow, checkHost, checkKeys, checkPort, checkReview, isObject,
} from '../../checks.js';
import { minimalEnv } from '../../exec.js';
import { kubectlBin, socketPath } from '../../paths.js';
import {
  READ_VERBS, closeCluster, hardRefusalDetail, kubeconfigText, kubectlArgs, openCluster, portListening, reapStaleProxies, versionCheck,
} from './cluster.js';
import { REVIEWED } from '../shared.js';

const REMOTE_RE = /^[A-Za-z0-9.-]+:\d{1,5}$/;
const KUBE_KEYS = ['name', 'kubeconfig', 'proxyPort', 'tunnel', 'manifestRoots', 'description', 'allow', 'review'];
const TUNNEL_KEYS = ['host', 'localPort', 'remote'];

function downMessage(target, state) {
  if (state === 'auth') return 'token rejected by the cluster';
  if (state === 'fail') return `cluster did not answer, see kube-${target.name}.log`;
  return 'proxy is not answering';
}

const SAMPLE = [
  {
    name: 'lab',
    kubeconfig: '~/.kube/lab-agent.yaml',
    proxyPort: 8001,
    tunnel: { host: 'bastion.example.com', localPort: 16443, remote: '127.0.0.1:6443' },
    manifestRoots: ['~/projects/lab/manifests'],
    description: 'lab cluster',
    allow: ['get ...', 'describe ...', 'logs ...', 'rollout status ...', 'apply -f *'],
  },
];

// The first port from port upward that used does not hold; it is added to used, so the next call skips it.
function nextFree(port, used) {
  let next = port;
  while (used.has(next)) next += 1;
  used.add(next);
  return next;
}

function decideKube(target, args) {
  const refusal = hardRefusalDetail(args, target.manifestRoots ?? []);
  if (refusal !== null) return { allowed: false, reason: refusal.reason, short: refusal.short };
  const decision = decide(args, target.allow);
  return decision.allowed ? decision : { ...decision, argv: [...args] };
}

export default {
  key: 'kubernetes',
  flag: 'kube',
  label: 'kube',
  word: 'kube',
  noun: 'cluster',
  countNoun: 'cluster(s)',
  sample: SAMPLE,
  // The sample with its proxy port, then its tunnel port, moved up to the first port that taken does not hold.
  freeSample(taken) {
    const used = new Set(taken);
    return SAMPLE.map((entry) => ({
      ...entry,
      proxyPort: nextFree(entry.proxyPort, used),
      tunnel: { ...entry.tunnel, localPort: nextFree(entry.tunnel.localPort, used) },
    }));
  },
  hint(target) {
    return target.description ? `${target.kubeconfig} — ${target.description}` : target.kubeconfig;
  },
  validate(entry, where, { reviewers, seenPorts }) {
    checkKeys(entry, KUBE_KEYS, where);
    const kubeconfig = absolutePath(entry.kubeconfig, `${where}: kubeconfig`);
    checkPort(entry.proxyPort, `${where}: proxyPort`, seenPorts);

    let tunnel = null;
    if (entry.tunnel !== undefined) {
      if (!isObject(entry.tunnel)) throw new InventoryError(`${where}: tunnel: must be an object`);
      checkKeys(entry.tunnel, TUNNEL_KEYS, `${where}: tunnel`);
      checkHost(entry.tunnel.host, `${where}: tunnel.host`);
      checkPort(entry.tunnel.localPort, `${where}: tunnel.localPort`, seenPorts);
      const remotePort = typeof entry.tunnel.remote === 'string' ? Number(entry.tunnel.remote.split(':').pop()) : NaN;
      if (typeof entry.tunnel.remote !== 'string' || !REMOTE_RE.test(entry.tunnel.remote)
        || remotePort < 1 || remotePort > 65535) {
        throw new InventoryError(`${where}: tunnel.remote: must be host:port`);
      }
      tunnel = { host: entry.tunnel.host, localPort: entry.tunnel.localPort, remote: entry.tunnel.remote };
    }

    let manifestRoots = [];
    if (entry.manifestRoots !== undefined) {
      if (!Array.isArray(entry.manifestRoots)) throw new InventoryError(`${where}: manifestRoots: must be an array`);
      manifestRoots = entry.manifestRoots.map((root, j) => absolutePath(root, `${where}: manifestRoots[${j}]`));
    }

    const allow = checkAllow(entry, where);
    return {
      kind: 'kubernetes',
      name: entry.name,
      kubeconfig,
      proxyPort: entry.proxyPort,
      tunnel,
      manifestRoots,
      description: entry.description ?? '',
      allow,
      ...checkReview(entry, where, reviewers, allow, { programs: false }),
    };
  },
  secretFiles(targets) {
    return targets.map((k) => k.kubeconfig);
  },
  // The ports on this machine that the entries listen on: the proxy port and the tunnel port of each. The entries are
  // validated targets, the entries of another inventory file read as JSON, or the targets of a session file.
  ports(entries) {
    return entries.flatMap((entry) => [entry.proxyPort, entry.tunnel?.localPort]);
  },
  // Stops the proxies a killed run left, by their pid files.
  async reapStale({ socketDir }) {
    const reaped = await reapStaleProxies(socketDir);
    return reaped > 0 ? [`closed ${reaped} proxy process(es) left by an earlier run`] : [];
  },
  // Only checks the length of the tunnel socket path; openCluster builds it again.
  prepare(targets, { env }) {
    for (const t of targets) {
      if (t.tunnel) socketPath('tun', t.name, env);
    }
    return new Map();
  },
  openingMessage(t) {
    return `port ${t.proxyPort}`;
  },
  async open(t, { sessionDir, env }) {
    const r = await openCluster(t, { sessionDir }, env);
    if (!r.ok) return r;
    return { ok: true, extras: { handle: r }, ...(r.state === 'up' ? {} : { warn: downMessage(t, r.state) }) };
  },
  // The check of ksproxy doctor: GET /version through the proxy that open started.
  doctor(opened, { timeoutMs, signal }) {
    return versionCheck(opened.target.proxyPort, { timeoutMs, signal });
  },
  closeLimit: 'kubeCloseMs',
  closeMs: 20000,
  close(o, { env }) {
    return closeCluster(o.handle, env);
  },
  onCloseTimeout(o) {
    o.handle.child?.kill('SIGKILL');
  },
  record(o, { reviewed }) {
    return {
      kind: 'kubernetes',
      name: o.target.name,
      description: o.target.description,
      allow: o.target.allow,
      proxyPort: o.target.proxyPort,
      manifestRoots: o.target.manifestRoots,
      tunnel: o.handle.tunnel,
      state: o.handle.state,
      ...(reviewed ? { review: true } : {}),
    };
  },
  sessionFiles(opened) {
    return [{
      name: 'kubeconfig',
      text: kubeconfigText(opened.map((o) => ({ name: o.target.name, proxyPort: o.target.proxyPort }))),
    }];
  },
  downMessage,
  backMessage: 'connection is back',
  decide: decideKube,
  notForReview(argv) {
    if (!READ_VERBS.has(argv[0])) return `only read verbs are reviewed, and ${argv[0]} is not one`;
    return null;
  },
  command(target, decision, { dir, env, input }) {
    return {
      program: kubectlBin(env),
      args: kubectlArgs(path.join(dir, 'kubeconfig'), target.name, decision.argv ?? input),
      options: {
        env: minimalEnv(env, {
          KUBECONFIG: path.join(dir, 'kubeconfig'), KUBERC: 'off', KUBECTL_KUBERC: 'false',
        }),
      },
    };
  },
  async state(target) {
    if (!(await portListening(target.proxyPort))) return 'down';
    return target.state;
  },
  scrubText(text, targets) {
    let out = text;
    for (const target of targets) {
      if (!Number.isInteger(target.proxyPort)) continue;
      out = out.replace(new RegExp(`(?:127\\.0\\.0\\.1|localhost):${target.proxyPort}(?!\\d)`, 'g'), '<proxy>');
    }
    return out;
  },
  toolBullet: '- `kubectl { cluster, args, timeout_seconds? }` - run kubectl against a cluster.',
  cutHint: 'logs --tail=200 or --since=10m, -l to select, -o name',
  agentSection(target) {
    const lines = [
      `### Kubernetes cluster \`${target.name}\`${target.description ? ` - ${target.description}` : ''}`,
      '',
      `- Tool: \`kubectl\` with \`cluster: "${target.name}"\``,
      `- Allowed commands: ${describeAllow(target.allow)}`,
      '- Pass `args` as an array with the verb first, one element per argument, for example `["get","pods","-n","web"]`.',
      '- Write short flags separately (`-o json`, not `-ojson`).',
      '- kubectl takes the verb first and only a fixed set of flags; any other verb or flag is refused. Output formats are `json`, `yaml`, `wide`, `name`, `jsonpath=...`, `jsonpath-as-json=...` and `custom-columns=...`.',
    ];
    if (target.manifestRoots.length > 0) {
      lines.push(`- \`-f\` and \`--patch-file\` each take one regular file (not a directory) inside: ${target.manifestRoots.join(', ')}`);
    } else {
      lines.push('- File flags (`-f`, `--patch-file`) are refused: this cluster has no manifest folders configured.');
    }
    if (target.state !== 'up') {
      lines.push(`- Connection state is \`${target.state}\`: calls may fail until the user fixes it.`);
    }
    if (target.review === true) lines.push(REVIEWED);
    return lines.join('\n');
  },
  tool: {
    name: 'kubectl',
    nameKey: 'cluster',
    detailKey: 'args',
    detailIsArray: true,
    definition: {
      name: 'kubectl',
      description: 'Run kubectl against an open Kubernetes cluster. The arguments are checked against that cluster\'s allowlist.',
      inputSchema: {
        type: 'object',
        required: ['cluster', 'args'],
        additionalProperties: false,
        properties: {
          cluster: { type: 'string', description: 'Target name from list_targets' },
          args: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'kubectl arguments, verb first, one array element per argument, e.g. ["get","pods","-n","web"]',
          },
          timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, default: 60 },
        },
      },
    },
  },
};

// Writes the RabbitMQ definitions of one e2e run, which the server loads at boot (load_definitions): the users of the
// rabbitmq examples of docs/EXAMPLES.md, the seed user, their permissions on the default virtual host, and the
// exchange orders bound to the queue orders. A password is kept only as RabbitMQ's salted SHA-256 hash. Arguments:
// the output file, then the files of the passwords of e2e-mq-reader, e2e-mq-ops and e2e-seed.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';

const [out, readerFile, opsFile, seedFile] = process.argv.slice(2);

// rabbit_password_hashing_sha256: base64 of a 4-byte salt followed by SHA-256(salt + password).
function hashOf(file) {
  const salt = randomBytes(4);
  const digest = createHash('sha256').update(Buffer.concat([salt, Buffer.from(fs.readFileSync(file, 'utf8').trim())])).digest();
  return Buffer.concat([salt, digest]).toString('base64');
}
const user = (name, file, tags) => ({
  name, password_hash: hashOf(file), hashing_algorithm: 'rabbit_password_hashing_sha256', tags,
});
const permission = (name, configure, write, read) => ({
  user: name, vhost: '/', configure, write, read,
});

const definitions = {
  users: [
    // "Use a RabbitMQ user with the monitoring tag and no configure or write permissions."
    user('e2e-mq-reader', readerFile, ['monitoring']),
    // "Give the user permissions that cover only these names": create orders-retry and bind it to the exchange orders.
    user('e2e-mq-ops', opsFile, ['management']),
    user('e2e-seed', seedFile, ['management']),
  ],
  vhosts: [{ name: '/' }],
  permissions: [
    permission('e2e-mq-reader', '^$', '^$', '^$'),
    permission('e2e-mq-ops', '^orders-retry$', '^orders-retry$', '^orders$'),
    permission('e2e-seed', '^$', '^orders$', '^$'),
  ],
  queues: [{
    name: 'orders', vhost: '/', durable: true, auto_delete: false, arguments: {},
  }],
  exchanges: [{
    name: 'orders', vhost: '/', type: 'direct', durable: true, auto_delete: false, internal: false, arguments: {},
  }],
  bindings: [{
    source: 'orders', vhost: '/', destination: 'orders', destination_type: 'queue', routing_key: 'orders', arguments: {},
  }],
};
fs.writeFileSync(out, `${JSON.stringify(definitions, null, 2)}\n`, { mode: 0o600 });

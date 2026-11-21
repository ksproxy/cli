import crypto from 'node:crypto';

// A self-signed certificate for the TLS stand-in, built in the test without any program: an EC P-256 key, a
// certificate for one DNS name, written in DER by hand and signed with node:crypto.

function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const oid = (...bytes) => tlv(0x06, Buffer.from(bytes));
const utf8 = (text) => tlv(0x0c, Buffer.from(text, 'utf8'));
const octets = (buffer) => tlv(0x04, buffer);
const bits = (buffer) => tlv(0x03, Buffer.from([0]), buffer);

function utcTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

const ECDSA_SHA256 = seq(oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02));
const COMMON_NAME = oid(0x55, 0x04, 0x03);
const SUBJECT_ALT_NAME = oid(0x55, 0x1d, 0x11);
const BASIC_CONSTRAINTS = oid(0x55, 0x1d, 0x13);

// { cert, key } as PEM texts, for the DNS name given.
export function selfSigned(dnsName = 'localhost') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const name = seq(set(seq(COMMON_NAME, utf8(dnsName))));
  const now = Date.now();
  const extensions = tlv(0xa3, seq(
    seq(BASIC_CONSTRAINTS, tlv(0x01, Buffer.from([0xff])), octets(seq(tlv(0x01, Buffer.from([0xff]))))),
    seq(SUBJECT_ALT_NAME, octets(seq(tlv(0x82, Buffer.from(dnsName, 'ascii'))))),
  ));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, Buffer.concat([Buffer.from([0x01]), crypto.randomBytes(8)])),
    ECDSA_SHA256,
    name,
    seq(utcTime(new Date(now - 86400000)), utcTime(new Date(now + 86400000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const signature = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = seq(tbs, ECDSA_SHA256, bits(signature));
  const lines = der.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

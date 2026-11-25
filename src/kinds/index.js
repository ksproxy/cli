import ssh from './ssh/index.js';
import kubernetes from './kubernetes/index.js';
import local from './local/index.js';
import http from './http/index.js';
import command from './command/index.js';
import elasticsearch from './elasticsearch/index.js';
import rabbitmq from './rabbitmq/index.js';
import redis from './redis/index.js';
import postgres from './postgres/index.js';
import mysql from './mysql/index.js';
import mongodb from './mongodb/index.js';
import kafka from './kafka/index.js';
import mcp from './mcp/index.js';

// The order is the order of opening, of the session file, of the agent notes and of the tools.
export const KINDS = [ssh, kubernetes, local, http, command, elasticsearch, rabbitmq, redis, postgres, mysql, mongodb, kafka, mcp];

export const kindByKey = (key) => KINDS.find((kind) => kind.key === key);
// A kind without a flag is never found by its flag, not even by an undefined one.
export const kindByFlag = (flag) => KINDS.find((kind) => kind.flag !== undefined && kind.flag === flag);
export const kindByTool = (name) => KINDS.find((kind) => kind.tool.name === name);

// The kinds that have a flag for ksproxy start, in list order. A kind without a flag is chosen with the picker or
// --all, and by a target name in ksproxy doctor.
export const flaggedKinds = () => KINDS.filter((kind) => kind.flag !== undefined);

// The name of a kind on the command line: its flag, or its key for a kind without a flag. ksproxy check takes it.
export const cliName = (kind) => kind.flag ?? kind.key;
export const kindByCliName = (name) => KINDS.find((kind) => cliName(kind) === name);

// The files that hold credentials, over every kind and every inventory entry, in list order.
export const secretFilesOf = (inventory) => KINDS.flatMap(
  (kind) => (kind.secretFiles === undefined ? [] : kind.secretFiles(inventory[kind.key])),
);

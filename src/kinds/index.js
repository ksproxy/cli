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

// The order is the order of opening, of the session file, of the agent notes and of the tools.
export const KINDS = [ssh, kubernetes, local, http, command, elasticsearch, rabbitmq, redis, postgres, mysql, mongodb, kafka];

export const kindByKey = (key) => KINDS.find((kind) => kind.key === key);
export const kindByFlag = (flag) => KINDS.find((kind) => kind.flag === flag);
export const kindByTool = (name) => KINDS.find((kind) => kind.tool.name === name);

// The files that hold credentials, over every kind and every inventory entry, in list order.
export const secretFilesOf = (inventory) => KINDS.flatMap(
  (kind) => (kind.secretFiles === undefined ? [] : kind.secretFiles(inventory[kind.key])),
);

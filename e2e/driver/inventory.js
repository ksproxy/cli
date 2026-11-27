// The inventory of the e2e run: the read-only and the read-and-write entries of docs/EXAMPLES.md for every kind but
// local (ssh, postgres, mysql, redis, mongodb, rabbitmq, http, mcp, elasticsearch, kafka, command and kubernetes),
// with the example hosts swapped for the container names, and a few entries that the docs describe elsewhere (jumps
// from docs/JUMPS.md, a "select ..." rule from docs/SERVICES.md). The caFile of the postgres and mysql examples is the
// CA of the run, which main.js copies there (see sql-tls.js). The rules of the examples are kept word for word;
// only the calls are adapted to what the containers have (see ssh.js), and kafka-ops has one more rule for a cluster of
// one node (see kafka.js). Each group of the run (see main.js) writes the kinds of its servers only.

export const MCP_PACKAGE = '@modelcontextprotocol/server-everything@2.3.1';
// The words of the local MCP server. npx finds the package in its cache: the image ran these same words at build.
const LOCAL_SERVER = ['npx', '-y', MCP_PACKAGE];
// The server's environment: npm reads its cache only, so the run needs no network. SHOP_REGION is a plain value that
// the server must see, as the check of get-env shows.
const LOCAL_ENV = { npm_config_offline: 'true', SHOP_REGION: 'e2e' };

export const inventory = {
  ssh: [
    {
      name: 'web1',
      host: 'web1',
      description: 'shop web server, read only',
      allow: [
        'uptime',
        'df -h',
        'free -m',
        'systemctl status *',
        'journalctl -u nginx -n * --no-pager',
        'tail -n * /var/log/nginx/error.log',
      ],
    },
    {
      name: 'web1-ops',
      host: 'web1',
      description: 'shop web server, may reload and restart nginx',
      allow: [
        'uptime',
        'systemctl status *',
        'journalctl -u nginx -n * --no-pager',
        'sudo nginx -t',
        'sudo systemctl reload nginx',
        'sudo systemctl restart nginx',
      ],
    },
    {
      // docs/JUMPS.md: a server reached only through another one, with a key stored on the first.
      name: 'app1',
      host: 'web1',
      description: 'app server behind web1, read only',
      jumps: ['ssh -i .ssh/app_key -o LogLevel=ERROR opsuser@app1'],
      allow: ['uptime', 'hostname', 'systemctl status *'],
    },
  ],
  postgres: [
    {
      name: 'shop-db',
      host: 'db',
      database: 'shop',
      user: 'agent_ro',
      passwordEnv: 'SHOP_DB_PASSWORD',
      caFile: '~/certs/db-ca.pem',
      description: 'shop database, read only',
      allow: [
        'select \\* from orders where id = *',
        'select count(\\*) from orders where status = *',
        'select id, status, total from orders where customer_id = * order by id desc limit 20',
      ],
    },
    {
      name: 'shop-db-rw',
      host: 'db',
      database: 'shop',
      user: 'agent_rw',
      passwordEnv: 'SHOP_DB_RW_PASSWORD',
      caFile: '~/certs/db-ca.pem',
      readOnly: false,
      description: 'shop database, may change the status of an order',
      allow: [
        'select \\* from orders where id = *',
        "update orders set status = 'shipped' where id = *",
        "update orders set status = 'cancelled' where id = *",
      ],
    },
    {
      // docs/SERVICES.md: "select ..." allows any statement that starts with select. The login may change the status
      // column, so only the read-only transaction of this target stops a function that writes.
      name: 'shop-db-wide',
      host: 'db',
      database: 'shop',
      user: 'agent_rw',
      passwordEnv: 'SHOP_DB_RW_PASSWORD',
      caFile: '~/certs/db-ca.pem',
      description: 'shop database, any select, read only',
      allow: ['select ...'],
    },
  ],
  mcp: [
    {
      // The read-only entry: the Jira tools of the example become two tools of the test server.
      name: 'everything',
      description: 'test MCP server over stdio, read only',
      command: LOCAL_SERVER,
      env: LOCAL_ENV,
      allow: ['echo', 'get-sum'],
    },
    {
      // The read-and-write entry: one tool allowed only with a pinned pattern on one argument, as jira_add_comment
      // with issue_key. get-env shows which environment variables the server gets.
      name: 'everything-rw',
      description: 'test MCP server over stdio, echo of SHOP messages only',
      command: LOCAL_SERVER,
      env: LOCAL_ENV,
      allow: ['get-sum', 'get-env', { tool: 'echo', arguments: { message: 'regex(SHOP-[0-9]+ .*)' } }],
    },
    {
      // "Remote server: use url, login and tokenEnv in place of command and env."
      name: 'everything-net',
      description: 'test MCP server over Streamable HTTP with a token, read only',
      url: 'https://mcp-remote:8443/mcp',
      login: 'token',
      tokenEnv: 'EVERYTHING_TOKEN',
      allow: ['echo', 'get-sum'],
    },
  ],
  mysql: [
    {
      name: 'crm-db',
      host: 'crm-db',
      database: 'crm',
      user: 'agent_ro',
      passwordEnv: 'CRM_DB_PASSWORD',
      caFile: '~/certs/db-ca.pem',
      description: 'crm database, read only',
      allow: ['show tables', 'describe customers', 'select \\* from customers where id = *'],
    },
    {
      name: 'crm-db-rw',
      host: 'crm-db',
      database: 'crm',
      user: 'agent_rw',
      passwordEnv: 'CRM_DB_RW_PASSWORD',
      caFile: '~/certs/db-ca.pem',
      client: 'mariadb',
      readOnly: false,
      description: 'crm database, may assign and close tickets',
      allow: [
        'select \\* from tickets where id = *',
        'update tickets set assignee = * where id = *',
        "update tickets set status = 'closed' where id = *",
      ],
    },
    {
      // As shop-db-wide: "select ..." on a read-only target whose login may change tickets, so only the read-only
      // transaction stops a function that writes.
      name: 'crm-db-wide',
      host: 'crm-db',
      database: 'crm',
      user: 'agent_rw',
      passwordEnv: 'CRM_DB_RW_PASSWORD',
      caFile: '~/certs/db-ca.pem',
      client: 'mariadb',
      description: 'crm database, any select, read only',
      allow: ['select ...'],
    },
  ],
  redis: [
    {
      name: 'cache',
      host: 'cache',
      port: 6380,
      tls: true,
      userEnv: 'REDIS_USER',
      passwordEnv: 'REDIS_PASSWORD',
      description: 'session cache, read only',
      allow: ['GET *', 'TTL *', 'HGETALL *', 'SCAN * MATCH session:* COUNT 100', 'INFO ...'],
    },
    {
      name: 'cache-ops',
      host: 'cache',
      port: 6380,
      tls: true,
      userEnv: 'REDIS_OPS_USER',
      passwordEnv: 'REDIS_OPS_PASSWORD',
      description: 'cache, may clear pages and switch new-checkout',
      allow: [
        'GET *',
        'TTL *',
        'regex(DEL cache:page:[a-z0-9-]+)',
        'SET feature:new-checkout on',
        'SET feature:new-checkout off',
      ],
    },
  ],
  mongodb: [
    {
      name: 'orders-db',
      uriEnv: 'ORDERS_MONGO_URI',
      database: 'shop',
      description: 'orders, read only',
      allow: ['find orders', 'count orders', 'aggregate orders', 'listCollections'],
    },
    {
      name: 'orders-rw',
      uriEnv: 'ORDERS_MONGO_RW_URI',
      database: 'shop',
      writes: true,
      description: 'orders, may update orders and add notes',
      allow: ['find orders', 'count orders', 'update orders', 'insert order_notes'],
    },
  ],
  rabbitmq: [
    {
      name: 'mq-prod',
      url: 'https://mq:15671',
      userEnv: 'MQ_USER',
      passwordEnv: 'MQ_PASSWORD',
      description: 'management API, read only',
      allow: ['GET /api/overview', 'GET /api/nodes', 'GET /api/queues/%2F/...', 'GET /api/exchanges/%2F/...'],
    },
    {
      name: 'mq-ops',
      url: 'https://mq:15671',
      userEnv: 'MQ_OPS_USER',
      passwordEnv: 'MQ_OPS_PASSWORD',
      description: 'management API, may set up orders-retry',
      allow: [
        'GET /api/overview',
        'GET /api/queues/%2F/...',
        'PUT /api/queues/%2F/orders-retry +body',
        'POST /api/bindings/%2F/e/orders/q/orders-retry +body',
      ],
    },
  ],
  http: [
    {
      name: 'grafana',
      baseUrl: 'https://grafana',
      auth: { bearerEnv: 'GRAFANA_TOKEN' },
      description: 'dashboards, read only',
      allow: ['GET /api/search', 'GET /api/dashboards/uid/*', 'GET /api/annotations'],
    },
    {
      name: 'grafana-notes',
      baseUrl: 'https://grafana',
      auth: { bearerEnv: 'GRAFANA_NOTES_TOKEN' },
      description: 'dashboards, may add annotations',
      allow: ['GET /api/search', 'GET /api/dashboards/uid/*', 'GET /api/annotations', 'POST /api/annotations +body'],
    },
  ],
  elasticsearch: [
    {
      name: 'es-logs',
      url: 'https://es:9200',
      apiKeyEnv: 'ES_LOGS_API_KEY',
      description: 'logs, read only',
      allow: [
        'GET /_cluster/health',
        'GET /_cat/indices',
        'GET /*/_mapping',
        'POST /*/_search +body',
        'POST /*/_count +body',
      ],
    },
    {
      name: 'search-rw',
      url: 'https://es:9200',
      userEnv: 'ES_SEARCH_USER',
      passwordEnv: 'ES_SEARCH_PASSWORD',
      description: 'products index, may update documents',
      allow: [
        'GET /_cluster/health',
        'POST /products/_search +body',
        'GET /products/_doc/*',
        'POST /products/_update/* +body',
      ],
    },
  ],
  kafka: [
    {
      name: 'kafka-prod',
      bootstrap: 'kafka:9093',
      clientConfig: '~/secrets/kafka-read.properties',
      binDir: '/opt/kafka/bin',
      description: 'production cluster, read only',
      allow: ['topics --list', 'topics --describe --topic *', 'groups --list', 'groups --describe --group *'],
    },
    {
      name: 'kafka-ops',
      bootstrap: 'kafka:9093',
      clientConfig: '~/secrets/kafka-ops.properties',
      binDir: '/opt/kafka/bin',
      writes: true,
      description: 'production cluster, may create orders-retry and reset billing',
      allow: [
        'topics --list',
        'topics --describe --topic *',
        'groups --describe --group *',
        'topics --create --topic orders-retry --partitions 6 --replication-factor 3',
        'groups --reset-offsets --group billing --topic orders --to-latest --execute',
        // Not in the example: the cluster of the run has one node, so a topic can have one copy of each partition only.
        'topics --create --topic orders-retry --partitions 6 --replication-factor 1',
      ],
    },
  ],
  kubernetes: [
    {
      // The kubeconfig holds a token of this run for the ServiceAccount lab-viewer of shop, which has the role view
      // there only (see e2e/images/k3s/shop.yaml); the driver copies it here from the volume kube.
      name: 'lab',
      kubeconfig: '~/.kube/lab-viewer.yaml',
      proxyPort: 8001,
      description: 'lab cluster, read only',
      allow: ['get ...', 'describe ...', 'logs ...', 'top pods ...', 'events ...'],
    },
    {
      // lab-deployer: view in shop, and a role that may restart and scale the deployment web only.
      name: 'lab-deploy',
      kubeconfig: '~/.kube/lab-deployer.yaml',
      proxyPort: 8002,
      description: 'lab cluster, may restart and scale shop/web',
      allow: [
        'get ...',
        'describe ...',
        'logs ...',
        'rollout status deployment/web -n shop',
        'rollout restart deployment/web -n shop',
        'regex(scale deployment/web --replicas=[1-5] -n shop)',
      ],
    },
  ],
  command: [
    {
      name: 'gh-shop',
      program: 'gh',
      env: { GH_TOKEN: { fromEnv: 'SHOP_GH_READ_TOKEN' } },
      description: 'issues and pull requests of example/shop, read only',
      allow: [
        'issue list -R example/shop',
        'issue view * -R example/shop',
        'pr list -R example/shop',
        'pr view * -R example/shop',
        'pr checks * -R example/shop',
      ],
    },
    {
      name: 'gh-triage',
      program: 'gh',
      env: { GH_TOKEN: { fromEnv: 'SHOP_GH_TRIAGE_TOKEN' } },
      description: 'issues of example/shop, may set two labels',
      allow: [
        'issue list -R example/shop',
        'issue view * -R example/shop',
        'regex(issue edit [0-9]+ (--add-label|--remove-label) (bug|needs-info) -R example/shop)',
      ],
    },
  ],
};

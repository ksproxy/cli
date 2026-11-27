# Redis 7 for the e2e tests: the cache of the redis examples of docs/EXAMPLES.md, over TLS on port 6380 with the
# certificate of the run, and the ACL users of the run (see start.sh). Nothing is downloaded here.
FROM redis:7-alpine

COPY redis.conf /usr/local/etc/redis/e2e.conf
COPY start.sh /usr/local/bin/e2e-start
RUN chmod 0644 /usr/local/etc/redis/e2e.conf && chmod 0755 /usr/local/bin/e2e-start

USER redis
ENTRYPOINT ["/usr/local/bin/e2e-start"]

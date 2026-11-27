# Kafka for the e2e tests: the cluster of the kafka examples of docs/EXAMPLES.md, one node in KRaft mode, with SASL
# PLAIN over TLS for the clients on port 9093, Kafka ACLs, and topics, messages and consumer groups seeded at each run
# (see start.sh). The image is apache/kafka; nothing is downloaded here.
FROM apache/kafka:4.4.0

USER root
RUN install -d -o appuser -g appuser -m 0755 /kafkalog
COPY server.properties /opt/e2e/server.properties
COPY log4j2.yaml /opt/e2e/log4j2.yaml
COPY start.sh /usr/local/bin/e2e-start
RUN chmod 0644 /opt/e2e/server.properties /opt/e2e/log4j2.yaml && chmod 0755 /usr/local/bin/e2e-start

USER appuser
ENTRYPOINT ["/usr/local/bin/e2e-start"]

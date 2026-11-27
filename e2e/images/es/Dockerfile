# Elasticsearch for the e2e tests: the cluster of the elasticsearch examples of docs/EXAMPLES.md, one node with security
# on and https with the certificate of the run, seeded at each run (see start.sh). The image is the Docker Official
# Image elasticsearch from Docker Hub: docker.elastic.co serves its layers through links that a proxy which replaces TLS
# certificates can break. Nothing is downloaded here. The request log of the HTTP layer (HttpTracer) goes to /eslog.
FROM elasticsearch:8.19.25

USER root
RUN install -d -o elasticsearch -g root -m 0775 /eslog /esout
COPY elasticsearch.yml /usr/share/elasticsearch/config/elasticsearch.yml
COPY requests.log4j2.properties /tmp/requests.log4j2.properties
COPY start.sh /usr/local/bin/e2e-start
RUN cat /tmp/requests.log4j2.properties >> /usr/share/elasticsearch/config/log4j2.properties \
 && rm /tmp/requests.log4j2.properties \
 && chmod 0664 /usr/share/elasticsearch/config/elasticsearch.yml && chmod 0755 /usr/local/bin/e2e-start

USER elasticsearch
ENTRYPOINT ["/bin/tini", "--", "/usr/local/bin/e2e-start"]

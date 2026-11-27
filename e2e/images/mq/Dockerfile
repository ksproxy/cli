# RabbitMQ for the e2e tests: the broker of the rabbitmq examples of docs/EXAMPLES.md. The image is
# rabbitmq:3.10.5-management, the version at hand: it is old, but its management API serves every call of the
# examples. Nothing is downloaded here. The defaults file of the image, which lets the user guest in from anywhere, is
# replaced by e2e.conf.
FROM rabbitmq:3.10.5-management

RUN rm -f /etc/rabbitmq/conf.d/10-defaults.conf \
 && install -d -o rabbitmq -g rabbitmq -m 0755 /mqlog
COPY e2e.conf /etc/rabbitmq/conf.d/20-e2e.conf
COPY start.sh /usr/local/bin/e2e-start
RUN chmod 0644 /etc/rabbitmq/conf.d/20-e2e.conf && chmod 0755 /usr/local/bin/e2e-start

USER rabbitmq
ENTRYPOINT ["/usr/local/bin/e2e-start"]

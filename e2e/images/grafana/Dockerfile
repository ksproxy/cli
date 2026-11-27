# A stand-in for the HTTP API of Grafana, for the http examples of docs/EXAMPLES.md (see server.js): plain Node on the
# image node:24, with no dependency and nothing downloaded. It listens on port 443 as the user node; compose.yaml lets
# an unprivileged user open that port.
FROM node:24

RUN install -d -o node -g node -m 0755 /httplog
COPY server.js /opt/grafana/server.js
RUN chmod 0644 /opt/grafana/server.js

USER node
CMD ["node", "/opt/grafana/server.js"]

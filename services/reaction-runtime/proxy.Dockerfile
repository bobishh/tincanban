FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ENV NODE_ENV=production REACTION_PROXY_PORT=3128
WORKDIR /proxy
COPY services/reaction-runtime/proxy.mjs /proxy/proxy.mjs
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/node", "/proxy/proxy.mjs"]

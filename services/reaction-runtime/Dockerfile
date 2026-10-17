FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
ARG RELEASE_SHA
ARG RELEASE_SDK_SHA
ENV RELEASE_SHA=${RELEASE_SHA} RELEASE_SDK_SHA=${RELEASE_SDK_SHA}
WORKDIR /source
COPY . .
RUN npm ci
RUN npm install --global pnpm@11.25.0 && pnpm --dir workers/automation install --prod --frozen-lockfile
RUN node services/reaction-runtime/build.mjs
RUN node --test services/reaction-runtime/dist/test/reactionRuntime.test.mjs services/reaction-runtime/proxy.test.mjs

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime
ARG RELEASE_SHA
ENV NODE_ENV=production NODE_USE_ENV_PROXY=1 \
    HTTP_PROXY=http://reaction-egress-proxy:3128 HTTPS_PROXY=http://reaction-egress-proxy:3128 \
    NO_PROXY= no_proxy= RELEASE_SHA=${RELEASE_SHA}
WORKDIR /reaction
COPY --from=build /source/services/reaction-runtime/dist/engine.mjs /reaction/engine.mjs
RUN chown 1000:1000 /reaction
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/node", "--max-old-space-size=512"]

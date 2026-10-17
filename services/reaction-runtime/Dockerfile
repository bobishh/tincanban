FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
ARG RELEASE_SHA
ARG RELEASE_SDK_SHA
ENV RELEASE_SHA=${RELEASE_SHA} RELEASE_SDK_SHA=${RELEASE_SDK_SHA}
WORKDIR /source
COPY . .
RUN npm ci
RUN npm install --global pnpm@11.25.0 && pnpm --dir workers/automation install --prod --frozen-lockfile
RUN node services/executor/build.mjs
RUN node --test services/executor/dist/test/reactionRuntime.test.mjs services/reaction-runtime/proxy.test.mjs

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends util-linux && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NODE_USE_ENV_PROXY=1 EXECUTOR_DATA_DIR=/state REACTION_SOURCE_PATH=/reaction/source.ts \
  EXECUTOR_WORKER_PATH=/app/participantWorker.mjs
WORKDIR /app
COPY --from=build /source/services/executor/dist/reactionRunner.mjs /reaction/runner.mjs
COPY --from=build /source/services/executor/dist/inspectReactionState.mjs /reaction/inspect-state.mjs
COPY --from=build /source/services/executor/dist/participantWorker.mjs /app/participantWorker.mjs
RUN mkdir -p /state && chown 1000:1000 /state /app /reaction
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/node", "--max-old-space-size=512", "/reaction/runner.mjs"]

FROM node:24-bookworm-slim AS build
WORKDIR /source
COPY . .
RUN npm ci
RUN npm install --global pnpm@11.25.0 && pnpm --dir workers/automation install --prod --frozen-lockfile
ARG RELEASE_SHA
ARG RELEASE_SDK_SHA
RUN RELEASE_SHA="$RELEASE_SHA" RELEASE_SDK_SHA="$RELEASE_SDK_SHA" node services/executor/build.mjs
RUN node services/executor/dist/run-tests.mjs

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends util-linux && rm -rf /var/lib/apt/lists/*
LABEL service="tincanban-executor"
ARG RELEASE_SHA
ARG RELEASE_SDK_SHA
LABEL org.opencontainers.image.source="https://github.com/bobishh/tincanban"
LABEL org.opencontainers.image.revision="$RELEASE_SHA"
ENV NODE_ENV=production PORT=8080 EXECUTOR_DATA_DIR=/data EXECUTOR_ARTIFACT_PATH=/app/artifact.json
ENV RELEASE_SHA="$RELEASE_SHA" RELEASE_SDK_SHA="$RELEASE_SDK_SHA"
WORKDIR /app
COPY --from=build /source/services/executor/dist/main.mjs /app/main.mjs
COPY --from=build /source/services/executor/dist/participantWorker.mjs /app/participantWorker.mjs
COPY --from=build /source/services/executor/dist/artifact.json /app/artifact.json
RUN mkdir -p /data && chown node:node /app /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s CMD node --input-type=module -e 'const response = await fetch("http://127.0.0.1:8080/health"); if (!response.ok) process.exit(1);'
CMD ["flock", "--no-fork", "--nonblock", "/data/executor.lock", "node", "--max-old-space-size=512", "/app/main.mjs"]

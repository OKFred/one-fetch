# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM docker.io/library/node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

ARG ONE_FETCH_VERSION
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="one-fetch Node adapter" \
      org.opencontainers.image.description="Self-hosted one-fetch Control and Gateway runtime" \
      org.opencontainers.image.source="https://github.com/OKFred/one-fetch" \
      org.opencontainers.image.version="${ONE_FETCH_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="docker.io/library/node:24.20.0-bookworm-slim" \
      org.opencontainers.image.base.digest="sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e"

ENV NODE_ENV=production \
    ONE_FETCH_CONTROL_HOST=0.0.0.0 \
    ONE_FETCH_GATEWAY_HOST=0.0.0.0 \
    ONE_FETCH_DATABASE_PATH=/var/lib/one-fetch/one-fetch.sqlite

RUN mkdir -p /var/lib/one-fetch \
    && chown node:node /var/lib/one-fetch \
    && chmod 0700 /var/lib/one-fetch

# The deterministic archive has one stable top-level directory: one-fetch/.
ADD one-fetch-node-${ONE_FETCH_VERSION}.tar.gz /opt/

WORKDIR /opt/one-fetch
USER node

EXPOSE 8787 8788
VOLUME ["/var/lib/one-fetch"]
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "const port=process.env.ONE_FETCH_CONTROL_PORT||'8787';fetch('http://127.0.0.1:'+port+'/api/v1/health').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "dist/cli.js"]

# The seshi relay, for a host with a public address.
#
# Source only. Node 24 runs the TypeScript directly, so there is no build step
# and nothing to keep in sync between what is tested and what ships.

FROM node:24-slim

WORKDIR /app

# The relay's only runtime dependency, pinned to what the lockfile resolves.
# Node ships a WebSocket client but not a server, which is the one thing this
# process is. The minimal package.json is written here rather than copied,
# because the repo root declares workspaces that are not in this image.
RUN printf '{"name":"seshi-relay","private":true,"type":"module"}' > package.json \
 && npm install --no-save --no-package-lock ws@8.21.3

COPY packages/relay/src ./packages/relay/src

ENV PORT=8787
EXPOSE 8787

CMD ["node", "packages/relay/src/main.ts"]

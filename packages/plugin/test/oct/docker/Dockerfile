FROM andreaskasper/openclaw:latest

USER root

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl jq ca-certificates procps lsof \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /tmp/openclaw && chown -R openclaw:openclaw /tmp/openclaw
RUN mkdir -p /home/openclaw/.openclaw /home/openclaw/.openclaw-dev && chown -R openclaw:openclaw /home/openclaw/.openclaw /home/openclaw/.openclaw-dev

USER openclaw

WORKDIR /home/openclaw/plugin
# Build context is repo root. Plugin lives under packages/plugin/.
COPY --chown=openclaw:openclaw . /home/openclaw/plugin

# Avoid Playwright browser downloads for tool-only tests
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /home/openclaw/plugin/packages/plugin
RUN npm install --ignore-scripts=false

ENV OCT_GATEWAY_URL=http://127.0.0.1:18789
ENV OCT_MODE=docker

ENTRYPOINT ["/home/openclaw/plugin/packages/plugin/scripts/test-oct.sh"]

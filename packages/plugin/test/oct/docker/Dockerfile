FROM andreaskasper/openclaw:latest

USER root

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl jq ca-certificates procps \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /plugin
COPY . /plugin

# Avoid Playwright browser downloads for tool-only tests
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --ignore-scripts=false

ENV OCT_GATEWAY_URL=http://127.0.0.1:18789
ENV OCT_MODE=docker

ENTRYPOINT ["/plugin/scripts/test-oct.sh"]

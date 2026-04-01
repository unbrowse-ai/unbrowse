FROM debian:bookworm-slim

ARG ZIG_VERSION=0.15.2
ARG BUN_VERSION=1.2.23

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/opt/zig:${PATH}"
ENV LIGHTPANDA_BIN="/usr/local/bin/lightpanda"
ENV CHROME_BIN="/usr/bin/chromium"
ENV RESULTS_ROOT="/workspace/.benchmarks/results"

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    chromium \
    curl \
    git \
    python3 \
    python3-pip \
    unzip \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
      amd64) zig_arch="x86_64"; lightpanda_arch="x86_64" ;; \
      arm64) zig_arch="aarch64"; lightpanda_arch="aarch64" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac \
  && curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-${zig_arch}-linux-${ZIG_VERSION}.tar.xz" -o /tmp/zig.tar.xz \
  && mkdir -p /opt \
  && tar -xf /tmp/zig.tar.xz -C /opt \
  && mv "/opt/zig-${zig_arch}-linux-${ZIG_VERSION}" /opt/zig \
  && curl -L -o /usr/local/bin/lightpanda "https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-${lightpanda_arch}-linux" \
  && chmod +x /usr/local/bin/lightpanda \
  && rm /tmp/zig.tar.xz

RUN curl -fsSL "https://bun.sh/install" | bash -s -- "bun-v${BUN_VERSION}" \
  && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
  && ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx

RUN bun install -g agent-browser
RUN python3 -m pip install --no-cache-dir --break-system-packages tiktoken

WORKDIR /workspace

COPY benchmarks/docker-entrypoint.sh /usr/local/bin/kuri-bench-entrypoint
RUN chmod +x /usr/local/bin/kuri-bench-entrypoint

ENTRYPOINT ["/usr/local/bin/kuri-bench-entrypoint"]

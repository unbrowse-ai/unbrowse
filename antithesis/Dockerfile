# The Antithesis harness's images, one stage each, built from the repository root:
#   docker compose -f antithesis/config/docker-compose.yaml build
#
#   node      the Unbrowse node, built with the Antithesis SDK and coverage, its symbols in /symbols
#   chain     Anvil as Arc testnet, with the stand-in registry and USDC, and Settlement deployed by the node's own CLI
#   site      the fixture shop whose API the nodes share a route to
#   workload  the test template and the driver that seeds the nodes' roles and signals setup complete
#
# Nothing here reaches the internet when it runs: everything is fetched while building.

# Pinned by digest: rust 1.99.1 on Debian bookworm, and Python 3.12 on Debian bookworm (slim). Every runtime image is
# glibc Debian; the node's runs on the Python image's Debian too, so the harness needs only these two bases.
ARG RUST_IMAGE=docker.io/library/rust:1-bookworm@sha256:5c1a1732ac3f77635b24d397ceb67b4d9ea61de348f68c0aa54a79fd01e65c69
ARG PYTHON_IMAGE=docker.io/library/python:3.12-slim-bookworm@sha256:1aaa65a85fda306ffb8b910824d4e93bdce61e212c7e87168123ea3073b41a1a
ARG DEBIAN_IMAGE=${PYTHON_IMAGE}

# ---- the node binary, instrumented ----
FROM ${RUST_IMAGE} AS node-build
# BoringSSL (the learner's TLS) builds with cmake, clang, Go and ninja; the TLS patch script needs Python.
RUN apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update \
 && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 install -y --no-install-recommends cmake clang libclang-dev golang-go ninja-build pkg-config libssl-dev python3 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY unbrowse-browser/core unbrowse-browser/core
COPY unbrowse-node unbrowse-node
# The node carries the terms it asks its owner about (terms.rs).
COPY TERMS.md PRIVACY.md ./
WORKDIR /src/unbrowse-node
# The vendored BoringSSL with Chrome's extensions, as CI makes it (vendor/ isn't committed).
RUN --mount=type=cache,id=unbrowse-antithesis-cargo-registry,target=/usr/local/cargo/registry \
    sh scripts/apply-tls-patch.sh
# Coverage needs the crate and the rustflags together (https://antithesis.com/docs/reference/sdk/rust/instrumentation/).
# No UNBROWSE_RELEASE: the build never updates itself and sets no network minimum. Line tables give Antithesis
# source locations without the size of full debug info.
ENV CARGO_PROFILE_RELEASE_DEBUG=line-tables-only \
    NO_COLOR=1 \
    CARGO_TERM_COLOR=never
RUN --mount=type=cache,id=unbrowse-antithesis-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=unbrowse-antithesis-target,target=/src/unbrowse-node/target \
    cargo build --release --locked -p unbrowse-node-app --bin unbrowse-node --features antithesis-coverage \
      --config 'build.target = "x86_64-unknown-linux-gnu"' \
      --config 'target.x86_64-unknown-linux-gnu.rustflags = ["-Ccodegen-units=1", "-Cpasses=sancov-module", "-Cllvm-args=-sanitizer-coverage-level=3", "-Cllvm-args=-sanitizer-coverage-trace-pc-guard", "-Cllvm-args=-sanitizer-coverage-pc-table", "-Clink-args=-Wl,--build-id"]' \
 && mkdir -p /out \
 && cp target/x86_64-unknown-linux-gnu/release/unbrowse-node /out/unbrowse-node
# The checks the instrumentation docs give: the runtime is linked and the coverage sections exist.
RUN nm /out/unbrowse-node | grep -q ' T antithesis_load_libvoidstar' \
 && readelf -S /out/unbrowse-node | grep -q __sancov_guards

# ---- what every node-side image runs on ----
FROM ${DEBIAN_IMAGE} AS node-base
RUN apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update \
 && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 install -y --no-install-recommends ca-certificates socat curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node-build /out/unbrowse-node /usr/local/bin/unbrowse-node
# Antithesis symbolizes coverage from the unstripped binary.
RUN mkdir -p /symbols && ln -s /usr/local/bin/unbrowse-node /symbols/unbrowse-node
ENV NO_COLOR=1 \
    UNBROWSE_TELEMETRY=0

# ---- the fixture shop's TLS: a test CA and a certificate for shop.example.com under it ----
# A route another node listed runs over HTTPS to a public address only (unbrowse-node/crates/learn/src/egress.rs), so the
# shop serves HTTPS and the nodes trust this CA: in the OS store, and through UNBROWSE_TEST_EXTRA_ROOTS for the
# Chrome-shaped transport, which reads it only in a build with the `antithesis` feature (learn `test-roots`).
FROM ${PYTHON_IMAGE} AS harness-certs
RUN apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update \
 && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /certs && cd /certs \
 && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ca.key -out ca.pem -days 3650 \
      -subj "/CN=Unbrowse Antithesis fixture CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
 && openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout shop.key -out shop.csr -subj "/CN=shop.example.com" \
 && printf 'subjectAltName=DNS:shop.example.com\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' > leaf.cnf \
 && openssl x509 -req -in shop.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out shop.pem -days 365 -extfile leaf.cnf \
 && openssl verify -CAfile ca.pem shop.pem \
 && rm ca.key shop.csr leaf.cnf

# ---- a node ----
FROM node-base AS node
COPY --from=harness-certs /certs/ca.pem /usr/local/share/ca-certificates/unbrowse-antithesis-ca.crt
RUN update-ca-certificates
ENV UNBROWSE_TEST_EXTRA_ROOTS=/usr/local/share/ca-certificates/unbrowse-antithesis-ca.crt
COPY antithesis/node/entrypoint.sh /usr/local/bin/unbrowse-antithesis-node
COPY antithesis/node/route-items.json antithesis/node/route-cart.json antithesis/node/route-lookup.json /opt/unbrowse-antithesis/
ENTRYPOINT ["/usr/local/bin/unbrowse-antithesis-node"]

# ---- the chain ----
FROM node-base AS chain
ARG FOUNDRY_VERSION=v1.8.5
ARG FOUNDRY_SHA256=6c66ffcc55fa4249197721baa3098bc208014ea1d8aa04b2ed50ac6bccffb226
RUN curl -fsSL "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_amd64.tar.gz" -o /tmp/foundry.tgz \
 && echo "${FOUNDRY_SHA256}  /tmp/foundry.tgz" | sha256sum -c - \
 && tar -xzf /tmp/foundry.tgz -C /usr/local/bin anvil cast \
 && rm /tmp/foundry.tgz \
 && apt-get update && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/*
# The stand-ins the node's own tests use (testchain.rs, chain.rs `stand_in_usdc`): the registry's runtime code, and the
# test USDC whose code is put at Arc's USDC address.
COPY unbrowse-node/app/tests/fixtures/erc8004/Erc8004StandIn.runtime.hex /opt/unbrowse-antithesis/Erc8004StandIn.runtime.hex
COPY unbrowse-node/app/contracts/USDC.json /opt/unbrowse-antithesis/USDC.json
COPY antithesis/chain/entrypoint.sh /usr/local/bin/unbrowse-antithesis-chain
ENTRYPOINT ["/usr/local/bin/unbrowse-antithesis-chain"]

# ---- the fixture site ----
FROM ${PYTHON_IMAGE} AS site
ENV NO_COLOR=1 PYTHONUNBUFFERED=1
COPY antithesis/site/site.py /opt/unbrowse-antithesis/site.py
COPY --from=harness-certs /certs/shop.pem /certs/shop.key /opt/unbrowse-antithesis/
ENTRYPOINT ["python3", "/opt/unbrowse-antithesis/site.py"]

# ---- the workload ----
FROM ${PYTHON_IMAGE} AS workload
ENV NO_COLOR=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
# The Antithesis Python SDK, and keccak for the chain's ABI.
RUN pip install --no-cache-dir antithesis==0.4.0 pycryptodome==3.23.0
# The project's own client for the node's agent API.
COPY unbrowse-sdk/python /tmp/unbrowse-sdk
RUN pip install --no-cache-dir /tmp/unbrowse-sdk && rm -rf /tmp/unbrowse-sdk
# The contracts' ABIs, which the invariants read the chain with.
COPY unbrowse-node/app/contracts /opt/unbrowse-antithesis/contracts
COPY antithesis/setup-complete.sh /usr/local/bin/setup-complete.sh
COPY antithesis/workload/entrypoint.py /opt/unbrowse-antithesis/entrypoint.py
COPY antithesis/test/ /opt/antithesis/test/v1/
# Python assertions are cataloged from the source Antithesis scans here.
RUN mkdir -p /opt/antithesis/catalog && ln -s /opt/antithesis/test/v1/unbrowse /opt/antithesis/catalog/unbrowse
ENTRYPOINT ["python3", "/opt/unbrowse-antithesis/entrypoint.py"]

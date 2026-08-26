# downbeat-source — built and deployed by `wrangler deploy` as a Cloudflare
# Container. Two stages: a Rust builder (cmake/g++ for the bundled libopus that
# audiopus_sys compiles statically) and a minimal Debian runtime that needs
# nothing but CA roots, since the whole TLS stack is rustls.
FROM rust:1-slim-bookworm AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends cmake make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
# --locked: the committed lockfile pins the vergen family to versions that
# actually build together (see Cargo.lock); a fresh resolution would not.
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/downbeat-source /usr/local/bin/downbeat-source
# The health/status port; Cloudflare Containers treat it as the readiness probe.
EXPOSE 8080
CMD ["downbeat-source"]

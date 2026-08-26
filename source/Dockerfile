# downbeat-source — built and deployed by `wrangler deploy` as a Cloudflare
# Container. Two stages: a Rust builder (cmake/g++ for the bundled libopus that
# audiopus_sys compiles statically) and a minimal Debian runtime that needs
# nothing but CA roots, since the whole TLS stack is rustls.
FROM rust:1-slim-bookworm AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends cmake make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Dependencies first, in their own layer: the librespot tree is ~400 crates
# and takes minutes; our own crate takes seconds. Building the deps against a
# stub main keyed only on the manifests means any edit to src/ reuses this
# layer wholesale — a redeploy recompiles one crate, not four hundred.
# --locked: the committed lockfile pins the vergen family to versions that
# actually build together (see Cargo.lock); a fresh resolution would not.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
  && printf 'fn main() {}\n' > src/main.rs \
  && cargo build --release --locked \
  && rm -rf src

# Now the real source. Touch it so cargo cannot mistake the stub's fingerprint
# for the real thing.
COPY src ./src
RUN touch src/main.rs && cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/downbeat-source /usr/local/bin/downbeat-source
# The health/status port; Cloudflare Containers treat it as the readiness probe.
EXPOSE 8080
CMD ["downbeat-source"]

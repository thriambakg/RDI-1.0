# RDI Proxy - Multi-stage build for minimal image
FROM rust:1.83-bookworm AS builder
WORKDIR /build
COPY . .
RUN cargo build --release

# Runtime image
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/target/release/rdi-proxy /usr/local/bin/
EXPOSE 8765 8766 8767
ENTRYPOINT ["/usr/local/bin/rdi-proxy"]

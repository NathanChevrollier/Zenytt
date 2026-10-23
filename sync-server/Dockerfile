# Serveur de synchronisation de Zenytt : binaire statique dans une petite image Alpine.
FROM rust:1-alpine@sha256:b1d5dd5a22a09404d3e798c0cf051b689077360374eb505fa5bb93c479693d87 AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM alpine:3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
RUN adduser -D -H -u 10001 zenytt && mkdir /data && chown zenytt /data
COPY --from=build /src/target/release/zenytt-sync /usr/local/bin/zenytt-sync
USER zenytt
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["zenytt-sync"]

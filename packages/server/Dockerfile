# The donor image ships sandbox-shim, which @cloudflare/sandbox's Files runs. Keep its tag equal to the package.
FROM docker.io/cloudflare/sandbox:1.0.3 AS sandbox-tools

FROM alpine:3.22
RUN apk add --no-cache git ca-certificates
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace
CMD ["sleep", "infinity"]

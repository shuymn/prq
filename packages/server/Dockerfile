# The cloud workspace's container (src/workspace.ts): git and the CA certificates for the checkout and the tools,
# python3 for skill scripts. It only waits; the Workspace runs every command through exec.
FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN apk add --no-cache git ca-certificates python3
CMD ["sleep", "infinity"]

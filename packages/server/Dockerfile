# The cloud workspace's container (src/workspace.ts): git and the CA certificates for the checkout and the tools,
# python3 for skill scripts, the unprivileged user they run as, and the root-owned runner that runs them
# (container/prq-skill-run.py). It only waits; the Workspace runs every command through exec.
# The runtime's umask for an exec is not guaranteed (0000 under local Docker), so the image sets it where root writes
# under /workspace: git through the wrapper first on PATH (container/git), the ready token's shell and the runner set
# their own, and /workspace is made here with mode 0755.
FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN apk add --no-cache git ca-certificates python3 \
  && adduser -D -H -s /sbin/nologin skill \
  && mkdir -m 0755 /workspace
COPY container/git /usr/local/bin/git
COPY container/prq-skill-run.py /usr/local/libexec/prq-skill-run
RUN chown root:root /usr/local/bin/git /usr/local/libexec/prq-skill-run \
  && chmod 0755 /usr/local/bin/git /usr/local/libexec/prq-skill-run
CMD ["sleep", "infinity"]

# syntax=docker/dockerfile:1.7
FROM ubuntu:24.04
LABEL org.opencontainers.image.title="InfraEnv Ubuntu Learning Sandbox" \
      org.opencontainers.image.description="Real Ubuntu shell with explicitly simulated S2 cluster command shims" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates coreutils gcc g++ make python3 procps \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /bin/bash learner
COPY --chmod=0555 docker/sandbox/infraenv-shim.py /usr/local/bin/infraenv
COPY --chmod=0555 docker/sandbox/entrypoint.sh /usr/local/bin/infraenv-entrypoint
RUN ln -s /usr/local/bin/infraenv /usr/local/bin/nvidia-smi \
    && ln -s /usr/local/bin/infraenv /usr/local/bin/sinfo \
    && ln -s /usr/local/bin/infraenv /usr/local/bin/squeue
USER learner
WORKDIR /home/learner
ENTRYPOINT ["/usr/local/bin/infraenv-entrypoint"]

# apps/deepagent/src/openshell/image/Dockerfile
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl git ca-certificates python3 python3-pip gnupg \
    && rm -rf /var/lib/apt/lists/*
# uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && ln -s /root/.local/bin/uv /usr/local/bin/uv
# Node LTS + npm + pnpm
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs && npm i -g pnpm
WORKDIR /workspace
# Wrappers are generated at build time by build.sh into ./wrappers and copied in.
COPY wrappers /usr/local/bin
RUN chmod -R +x /usr/local/bin
ENV OPENSHELL_BRIDGE_HOST=host.docker.internal OPENSHELL_BRIDGE_PORT=7777
CMD ["bash"]
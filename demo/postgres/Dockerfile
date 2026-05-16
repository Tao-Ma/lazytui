# Builder + runtime image for postgres 16 from source.
# Produced by the lazytui loop — see ../postgres/.agent-prompt.md.
#
# Single image strategy: the container ships with build deps + source
# pre-cloned, sleeps as its main process, and demo actions exec into
# it to drive build / test / server-lifecycle. Keeps the compose stack
# to one service.

FROM debian:bookworm

# Build deps. Kept minimal — fancier configure flags would pull more.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        git \
        flex \
        bison \
        ca-certificates \
        libreadline-dev \
        zlib1g-dev \
        libicu-dev \
        pkg-config \
        procps \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash postgres

ARG PG_TAG=REL_16_STABLE
ENV PG_TAG=${PG_TAG}

# Pre-clone the source into the image so the first `build` action
# doesn't pay the clone cost. Subsequent updates can `git fetch` from
# inside the container.
USER postgres
WORKDIR /home/postgres
RUN git clone --depth 1 --branch ${PG_TAG} \
        https://github.com/postgres/postgres.git src

USER root
RUN mkdir -p /opt/pg /var/lib/postgresql/data \
    && chown -R postgres:postgres /opt/pg /var/lib/postgresql

# Action scripts. Baked into the image rather than bind-mounted from
# the host because bind mounts break under docker-in-docker (the host
# daemon and the calling container see different filesystems at the
# same path). Image-baked scripts work in both DinD and on metal.
COPY --chown=postgres:postgres scripts /scripts
RUN chmod 0755 /scripts/*.sh

USER postgres
WORKDIR /home/postgres
CMD ["sleep", "infinity"]

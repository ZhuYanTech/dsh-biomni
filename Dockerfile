# syntax=docker/dockerfile:1.7
# The Biomni interpreter as an image, for deployments that would rather
# provision once than have every user build a venv.
#
# This image is ONLY the Python environment. The plugin itself stays where dsh
# installed it — this is not a way to run dsh in a container, it is a way to
# give dsh an interpreter it did not have to build.
#
# Build:
#
#   docker build -t dsh-biomni-env .
#   docker build -t dsh-biomni-env --build-arg EXTRAS=1 .   # +494 MB, 7 functions
#
# HOW THE PLUGIN REACHES IT, honestly: the plugin spawns its worker as
# `<python> -u <path-to-worker.py>`, and both the interpreter and that path have
# to exist in the same place. A container satisfies that only if the plugin's
# own `python/` directory is mounted into it AND the `python` setting names a
# command that runs inside it. That means a wrapper script on the host:
#
#   #!/bin/sh
#   exec docker run --rm -i \
#     -v "$DSH_BIOMNI_DIR/python:$DSH_BIOMNI_DIR/python:ro" \
#     -v "$DSH_BIOMNI_DATA:/data" \
#     dsh-biomni-env python "$@"
#
# with `biomni.python` pointing at that script and `biomni.dataPath` at /data.
# The worker speaks newline-delimited JSON over stdio, so `-i` is the only
# docker flag that matters for the protocol.
#
# This is more moving parts than a venv, and worth it mainly when many people
# share one provisioned environment. For a single machine, scripts/setup-env.sh
# is the shorter road.

FROM python:3.11-slim

# Biomni's tools shell out to command-line bioinformatics tools for some of
# their work, and its library needs a compiler for a few wheels. Kept to what
# the core tier actually uses — the software catalog reports the rest as absent
# rather than the image pretending to have them.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

# uv, for the same reason scripts/setup-env.sh prefers it: 11 seconds where pip
# takes minutes, on an identical resolution.
COPY --from=ghcr.io/astral-sh/uv:0.8.17 /uv /usr/local/bin/uv

WORKDIR /opt/biomni

# The lock first, so the expensive layer is cached against changes to anything
# else in the repo.
COPY python/requirements-biomni.lock.txt python/requirements-biomni-extras.txt ./

ARG EXTRAS=0
RUN uv pip install --system -r requirements-biomni.lock.txt \
    && if [ "$EXTRAS" = "1" ]; then uv pip install --system -r requirements-biomni-extras.txt; fi \
    && rm -rf /root/.cache/uv

# The probe and its shared analysis, so the image can report on itself without
# the plugin mounted. `docker run --rm dsh-biomni-env verify` is a build check.
COPY python/_gates.py python/probe.py /opt/biomni-tools/
COPY data/biomni-manifest.json /opt/biomni-data/biomni-manifest.json

# _gates.py resolves the vendored manifest as ../data/biomni-manifest.json
# relative to itself, so the two directories must sit side by side.
RUN mkdir -p /opt/dsh-biomni/python /opt/dsh-biomni/data \
    && mv /opt/biomni-tools/* /opt/dsh-biomni/python/ \
    && mv /opt/biomni-data/biomni-manifest.json /opt/dsh-biomni/data/ \
    && rmdir /opt/biomni-tools /opt/biomni-data

# Datasets live here; mount a host directory over it to keep them.
ENV BIOMNI_PATH=/data
VOLUME /data

# `verify` runs the probe; anything else is executed as given, so
# `docker run ... python -u /mnt/plugin/python/worker.py` works as the plugin
# expects once the plugin directory is mounted.
COPY <<'ENTRY' /usr/local/bin/entrypoint
#!/bin/sh
if [ "$1" = "verify" ]; then
  exec python /opt/dsh-biomni/python/probe.py
fi
exec "$@"
ENTRY
RUN chmod +x /usr/local/bin/entrypoint

ENTRYPOINT ["/usr/local/bin/entrypoint"]
CMD ["verify"]

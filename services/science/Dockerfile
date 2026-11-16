# syntax=docker/dockerfile:1
#
# MATTER LAB science service image.
# Build context: the repository root (see docker-compose.yml and the root .dockerignore).
FROM node:24-bookworm-slim AS lab-build
WORKDIR /build
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web/package.json ./apps/web/package.json
COPY apps/web/src/lab/apparatus ./apps/web/src/lab/apparatus
COPY services/science/node ./services/science/node
RUN npm ci --ignore-scripts \
 && npm run build --workspace @matterlab/lab-science \
 && npm run build --workspace @matterlab/lab-runtime \
 && npx vite build --config services/science/node/vite.config.ts \
 && npx vite build --config services/science/node/vite.catalog.config.ts \
 && node services/science/node/dist/export-catalog.mjs

FROM python:3.12-slim-bookworm

# Set to 0 to build without the optional quantum-chemistry engines (tblite/xTB, ASE, PySCF).
# The service detects what is installed at runtime, so both variants are valid images.
ARG MATTERLAB_OPTIONAL_ENGINES=1

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore \
    PYTHONPATH=/app \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    MATTERLAB_MIGRATIONS_DIR=/db/migrations \
    MATTERLAB_GENERATED_DATA_DIR=/data/generated \
    MATTERLAB_SEED_DIR=/app/seed \
    MATTERLAB_LAB_SCHEMA_PATH=/opt/lab/contracts/lab-v1.schema.json \
    MATTERLAB_LAB_VALIDATOR_PATH=/opt/lab/node/validate.mjs \
    MATTERLAB_LAB_RUNNER_PATH=/opt/lab/runtime/cli.mjs \
    MATTERLAB_LAB_CATALOG_DIR=/opt/lab/runtime/catalog

# libgomp1: OpenMP runtime needed by the tblite wheel (it is not bundled there).
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY services/science/constraints.txt services/science/requirements.txt /opt/matterlab-build/
RUN pip install -c /opt/matterlab-build/constraints.txt -r /opt/matterlab-build/requirements.txt

COPY services/science/requirements-engines.txt /opt/matterlab-build/
RUN if [ "$MATTERLAB_OPTIONAL_ENGINES" = "1" ]; then \
      pip install -c /opt/matterlab-build/constraints.txt -r /opt/matterlab-build/requirements-engines.txt; \
    else \
      echo "optional engines not installed (MATTERLAB_OPTIONAL_ENGINES=$MATTERLAB_OPTIONAL_ENGINES)"; \
    fi

COPY services/science/requirements-test.txt /opt/matterlab-build/
RUN pip install -c /opt/matterlab-build/constraints.txt -r /opt/matterlab-build/requirements-test.txt

RUN groupadd --gid 10001 matterlab \
 && useradd --uid 10001 --gid 10001 --home-dir /home/matterlab --create-home --shell /usr/sbin/nologin matterlab

# Baked-in copies so the image works on its own; docker-compose.yml additionally bind-mounts the
# live directories read-only over /db/migrations and /data/generated.
COPY db/migrations /db/migrations
COPY tools/data/generated /data/generated
COPY services/science /app
COPY --from=lab-build /usr/local/bin/node /usr/local/bin/node
COPY --from=lab-build /build/packages/contracts/schemas/lab-v1.schema.json /opt/lab/contracts/lab-v1.schema.json
COPY --from=lab-build /build/services/science/node/dist /opt/lab/node
COPY --from=lab-build /build/packages/lab-runtime/dist /opt/lab/runtime

# Bytecode is compiled once here (PYTHONDONTWRITEBYTECODE stops it being written at run time), so
# every worker process starts from cached bytecode.
RUN python -m compileall -q /app/matterlab_science

USER matterlab
EXPOSE 8787

HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=6 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8787/health', timeout=4).status == 200 else 1)"]

CMD ["python", "-m", "matterlab_science", "serve"]

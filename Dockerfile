FROM node:20-alpine
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy whole repo so workspace + link deps resolve
COPY . .

RUN pnpm install --frozen-lockfile

# Fix: libsodium-wrappers-sumo imports ./libsodium-sumo.mjs as a relative sibling,
# but pnpm's strict isolation places it in a separate package directory.
# Copy the file so the relative import resolves at runtime.
RUN WRAPPER_ESM_DIR=$(find node_modules/.pnpm -path "*/libsodium-wrappers-sumo/dist/modules-sumo-esm" -type d | head -1) && \
    SODIUM_FILE=$(find node_modules/.pnpm -path "*/libsodium-sumo/dist/modules-sumo-esm/libsodium-sumo.mjs" -type f | head -1) && \
    if [ -n "$WRAPPER_ESM_DIR" ] && [ -n "$SODIUM_FILE" ]; then \
      cp "$SODIUM_FILE" "$WRAPPER_ESM_DIR/"; \
      echo "Fixed libsodium-sumo.mjs placement"; \
    fi

# Build @subbit-tx packages (separate workspace inside subbit-xyz/js)
WORKDIR /app/services/subbit-xyz/js
RUN pnpm install --frozen-lockfile
RUN pnpm build

WORKDIR /app/services/subbit-man-js

EXPOSE 7822
CMD ["pnpm", "start"]

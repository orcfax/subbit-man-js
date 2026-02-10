FROM node:20-alpine
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy whole repo so workspace + link deps resolve
COPY . .

RUN pnpm install --frozen-lockfile

# Build @subbit-tx packages (separate workspace inside subbit-xyz/js)
WORKDIR /app/services/subbit-xyz/js
RUN pnpm install --frozen-lockfile
RUN pnpm build

WORKDIR /app/services/subbit-man-js

EXPOSE 7822
CMD ["pnpm", "start"]

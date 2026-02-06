FROM node:20-alpine
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy whole repo so workspace + link deps resolve
COPY . .

RUN pnpm install --frozen-lockfile

WORKDIR /app/services/subbit-man-js

EXPOSE 7822
CMD ["pnpm", "start"]

# POD Miner USDC Rewards Distributor v1 — runtime image.
# Contains the distributor CLI, the scheduler, and the read-only API.
# The on-chain program is NOT built here (see anchor build --verifiable).

FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare yarn@1.22.22 --activate
COPY package.json yarn.lock ./
COPY packages/merkle/package.json packages/merkle/
COPY packages/distributor/package.json packages/distributor/
COPY packages/api/package.json packages/api/
COPY packages/claim-sdk/package.json packages/claim-sdk/
COPY packages/programs-wrappers/package.json packages/programs-wrappers/
RUN yarn install --frozen-lockfile --production=false

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/merkle packages/merkle
COPY packages/distributor packages/distributor
COPY packages/api packages/api
COPY packages/claim-sdk packages/claim-sdk
COPY packages/programs-wrappers packages/programs-wrappers
COPY target/idl target/idl
COPY target/types target/types
COPY migrations migrations
RUN yarn workspaces run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare yarn@1.22.22 --activate
COPY --from=build /app/package.json /app/yarn.lock ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/merkle/dist packages/merkle/dist
COPY --from=build /app/packages/merkle/package.json packages/merkle/
COPY --from=build /app/packages/distributor/dist packages/distributor/dist
COPY --from=build /app/packages/distributor/package.json packages/distributor/
COPY --from=build /app/packages/api/dist packages/api/dist
COPY --from=build /app/packages/api/package.json packages/api/
COPY --from=build /app/packages/claim-sdk/dist packages/claim-sdk/dist
COPY --from=build /app/packages/claim-sdk/package.json packages/claim-sdk/
COPY --from=build /app/migrations migrations
USER node
CMD ["node", "packages/distributor/dist/cli.js", "--help"]

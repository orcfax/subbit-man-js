# Architecture

This document describes the system architecture of Orcfax On-Demand — how the pieces fit together, how data flows, and why certain design decisions were made.

## System Overview

Orcfax On-Demand is a three-tier system: a browser-based frontend, a SvelteKit middleware server, and two backend services.

```
                          ┌─────────────────────┐
                          │   Cardano (L1)       │
                          │  Subbit smart contract│
                          │  (escrowed ADA)      │
                          └──────────┬───────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                 │
              ┌─────▼──────┐  ┌─────▼──────┐   ┌─────▼──────┐
              │  Blockfrost │  │  SubbitMan  │   │  Orcfax    │
              │  (indexer)  │  │  (L2 state) │   │  Validator │
              └─────┬──────┘  └─────┬──────┘   └─────┬──────┘
                    │               │                 │
                    └───────┬───────┴────────┬────────┘
                            │                │
                     ┌──────▼────────────────▼──────┐
                     │      SvelteKit Server         │
                     │  Remote functions + REST API  │
                     └──────────────┬────────────────┘
                                    │
                     ┌──────────────▼────────────────┐
                     │        Browser (Svelte 5)      │
                     │  Wallet + Keys + Channel + UI  │
                     └────────────────────────────────┘
```

### Browser (Client)

A Svelte 5 SPA using runes for reactivity. Handles:

- **Wallet connection** via Mesh SDK (CIP-30 standard for Cardano browser wallets)
- **Ed25519 key management** — generation, storage (IndexedDB), export (JSON keyfile)
- **Channel open transactions** — builds Cardano transactions client-side using Mesh SDK's `MeshTxBuilder`
- **IOU signing** — signs payment credentials locally with the user's Ed25519 private key
- **Price feed display** — TanStack Table for feeds, IndexedDB for price history

SSR is disabled globally (`ssr = false` in the root layout). The app is fully client-rendered because it depends on browser APIs (CIP-30 wallets, IndexedDB, localStorage).

### SvelteKit Server

Acts as a middleware proxy between the browser and backend services. Two communication patterns:

1. **Remote functions** (`*.remote.ts`) — SvelteKit experimental feature. The client calls server-side functions directly without manually defining API routes. Used by the portal UI.

2. **REST API** (`/api/*`) — traditional HTTP endpoints for programmatic/CLI access. Both patterns share the same underlying logic via `subbitProxy.ts`.

The server never holds private keys or wallet connections. It:

- Validates credentials by forwarding them to SubbitMan
- Fetches oracle data from the Orcfax validator node
- Charges request costs via SubbitMan
- Returns ToS version/hash headers on paid responses

### SubbitMan

A Fastify-based Node.js service (`services/subbit-man-js`) that manages the provider side of Subbit payment channels:

- **L2 accounting** — tracks channel state (cost, IOU amounts, signatures) in LevelDB
- **L1 transaction building** — constructs Add, Close, End, Expire, and Settle transactions using Lucid Evolution
- **Liaison loop** — automated background process that periodically syncs chain state, settles closed channels, and claims owed funds
- **Credential validation** — verifies Ed25519 signatures, checks IOU amounts, records authorized payments

### Orcfax Validator Node

The upstream data source. Provides:

- `GET /feeds` — list of available price feed IDs
- `GET /subbit/request?feed_id=X` — fetch latest price data
- `POST /subbit/request?feed_id=X` — publish a price datum on-chain

The SvelteKit server proxies requests to this service after validating and charging credentials.

### Cardano / Blockfrost

The L1 blockchain where Subbit channels exist as UTxOs. Blockfrost provides chain indexing (UTxO lookups, transaction submission confirmation). The Subbit smart contract (written in Aiken, source in `services/subbit-xyz/aik/`) enforces escrow rules on-chain.

## The Subbit Protocol

Subbit is an L2 payment channel protocol on Cardano. It solves the problem of paying per API request without submitting a blockchain transaction for each call.

### Why L2 channels?

A Cardano transaction costs ~0.2 ADA in fees and takes ~20 seconds to confirm. If every price fetch (0.01 ADA) required an on-chain transaction, the fee would exceed the service cost by 20x, and latency would be unusable. Payment channels move accounting off-chain while keeping funds secured by on-chain escrow.

### Channel lifecycle

```
                 ┌────────┐
                 │  Open  │ ← Consumer locks ADA in smart contract
                 └───┬────┘
                     │
              ┌──────▼──────┐
              │  Active Use  │ ← Sign IOUs per request (off-chain)
              │  (Add Funds) │ ← Optionally top up
              └──────┬──────┘
                     │
                ┌────▼────┐
                │  Close  │ ← Consumer starts settlement window
                └────┬────┘
                     │
            ┌────────┴────────┐
            │                 │
       ┌────▼────┐      ┌────▼─────┐
       │ Settle  │      │  Expire  │ ← If provider doesn't settle
       │(provider│      │(consumer │   within the deadline
       │ claims) │      │ reclaims │
       └────┬────┘      │   all)   │
            │           └──────────┘
       ┌────▼────┐
       │   End   │ ← Consumer reclaims remainder
       └─────────┘
```

**Open** — The consumer builds a transaction (client-side) that sends ADA to the Subbit script address. The UTxO's inline datum encodes: channel tag, IOU public key, consumer key hash, provider key hash, and close period. After tx confirmation, the channel is synced to SubbitMan.

**Active Use** — The consumer signs IOUs (off-chain) for each API request. No blockchain transactions needed. The consumer can also add more ADA to the channel via an Add transaction.

**Close** — The consumer signs a Close transaction. This starts a settlement window (1 hour per current ToS). The channel UTxO's datum is updated with a deadline.

**Settle** — During the settlement window, the provider submits a Settle transaction claiming authorized funds (up to the latest IOU amount). The smart contract verifies the IOU signature on-chain.

**End** — After settlement, the consumer submits an End transaction to reclaim remaining funds.

**Expire** — If the provider doesn't settle before the deadline, the consumer can submit an Expire transaction to reclaim **all** escrowed funds. This is the consumer's safety net.

### Credential system

Every authenticated API request includes an `X-Credential` header containing a base64url-encoded CBOR payload. Three credential types exist:

**IOU** (CBOR tag 121) — `[channelTag, cumulativeAmount]`
Authorizes payment. The amount is the **cumulative total** the provider may claim, not an incremental amount. Each new IOU replaces the previous one. Example: if you've spent 30,000 lovelace and want to fetch a price (10,000 lovelace), you sign an IOU for 40,000.

**Stamp** (CBOR tag 122) — `[channelTag, timestampMs]`
Proves channel ownership without authorizing payment. Used for free operations like checking channel state. The server validates that the timestamp is recent.

**Fixed** (CBOR tag 123) — `[channelTag, seed]`
Deterministic credential for specific use cases.

A `Cred` bundles: the Ed25519 public key, the message, and the Ed25519 signature over the CBOR-encoded message.

### Accounting model

SubbitMan tracks five values per channel:

| Field       | Description                                                          |
| ----------- | -------------------------------------------------------------------- |
| `cost`      | Actual amount owed to provider (increases with each charged request) |
| `iouAmt`    | Maximum amount consumer has authorized via latest IOU                |
| `sub`       | Amount already settled on L1                                         |
| `subbitAmt` | Total ADA locked in the L1 UTxO                                      |
| `sig`       | Current IOU signature (hex)                                          |

The consumer's available balance (displayed in the UI): `subbitAmt - cost - CHANNEL_RESERVE`

The provider can claim up to `iouAmt` when settling. The difference between `iouAmt` and `cost` is the consumer's "overpayment buffer" — IOUs must be >= cost to be accepted, but can be higher.

## State Management

The app uses Svelte 5 runes (`$state`, `$derived`, `$effect`) with the Svelte context API for dependency injection.

### Reactive singletons

Six reactive class instances are created in the app layout (`src/routes/app/+layout.svelte`) and injected via `createContext`:

```
NetworkState  →  Wallet  →  AuthKey  →  ChannelStore  →  Channel  →  ODAPI
```

| Class          | Responsibilities                                 | Storage                               |
| -------------- | ------------------------------------------------ | ------------------------------------- |
| `NetworkState` | Preview/Mainnet selection                        | localStorage                          |
| `Wallet`       | CIP-30 wallet connection, tx signing             | localStorage (wallet name)            |
| `AuthKey`      | Ed25519 keypair, key file export                 | IndexedDB (optional cache)            |
| `ChannelStore` | Registry of all channels (multi-channel support) | localStorage                          |
| `Channel`      | Active channel lifecycle, accounting, sync       | Derived from ChannelStore + SubbitMan |
| `ODAPI`        | Feed list, prices, publish, history              | IndexedDB (price history)             |

Child components access these via `getXState()` context getters. Each class manages its own persistence (localStorage or IndexedDB) and exposes reactive state via `$state` and `$derived`.

### Data flow for a price request

```
User clicks "Update" on ADA-USD
  → ODAPI.updateFeedPrice("ADA-USD")
    → ODAPI.getPrice("ADA-USD")
      → Channel.getNextIouAmount(10_000n)     // calculate next IOU
      → createIouCredential(privateKey, tag, amount)  // sign IOU
      → getPrices({ feedIds, credential })    // remote function call
        ──► SvelteKit Server ──►
          → validateCredential(cred)          // SubbitMan /l2/tot
          → fetch(validatorUrl/subbit/request) // Orcfax validator
          → chargeCost(cred, 10_000n)         // SubbitMan /l2/mod
        ◄── returns price data ◄──
      → storePriceUpdate(feedId, price)       // IndexedDB
      → Channel.sync()                        // refresh accounting
```

## Remote Functions

SvelteKit's experimental `remoteFunctions` feature allows server-side TypeScript functions to be called directly from client code, without defining API routes.

Files named `*.remote.ts` in `src/lib/` contain these functions. They use `query()` (for reads) and `command()` (for writes) from `$app/server`.

```
src/lib/
├── odapi/
│   ├── feeds.remote.ts      # getFeeds()
│   ├── prices.remote.ts     # getPrices()
│   └── publish.remote.ts    # publishPrices()
└── subbit/
    ├── subbit.remote.ts     # getInfo(), getTot(), syncL1(), etc.
    └── server/
        ├── sync.remote.ts   # syncChannels()
        ├── add.remote.ts    # buildAddTx()
        ├── close.remote.ts  # buildCloseTx()
        ├── settle.remote.ts # settleChannel()
        ├── withdraw.remote.ts # buildEndTx(), buildExpireTx()
        └── info.remote.ts   # getCurrentChannelState(), getChannelOnChainState()
```

### Why remote functions?

They eliminate boilerplate. Without them, each operation would need a `+server.ts` route, a fetch call, and manual serialization. Remote functions handle all of this transparently. The REST API (`/api/*`) provides the same operations for programmatic access.

## REST API

Traditional SvelteKit API routes for CLI/programmatic consumers:

| Endpoint       | Method | Auth  | Description               |
| -------------- | ------ | ----- | ------------------------- |
| `/api/feeds`   | GET    | None  | List available feed IDs   |
| `/api/tos`     | GET    | None  | Get Terms of Service JSON |
| `/api/channel` | GET    | Stamp | Get channel state         |
| `/api/prices`  | GET    | IOU   | Fetch price data          |
| `/api/publish` | POST   | IOU   | Publish on-chain datum    |

The `subbitProxy.ts` module provides shared helpers for both remote functions and REST routes: credential extraction, SubbitMan validation/charging, ToS header generation, and error mapping.

## Terms of Service

The ToS (`src/lib/tos/tos.json`) is a versioned, Blake2b-hashed JSON document that defines pricing, channel parameters, and legal clauses.

Key mechanisms:

- **Pricing derivation** — service costs are read from the ToS at startup, not hardcoded
- **Hash integrity** — the ToS JSON is Blake2b-hashed; the hash is included in key files and API response headers
- **Grace period** — when ToS updates, a grace period (currently 7 days) allows consumers to continue using previous pricing
- **API enforcement** — after the grace period, paid REST endpoints require an `X-ToS-Accepted` header matching the current version

## Key Dependencies

| Package                  | Why                                                                |
| ------------------------ | ------------------------------------------------------------------ |
| `@meshsdk/core`          | CIP-30 wallet connection, client-side Cardano transaction building |
| `@lucid-evolution/lucid` | Server-side Cardano transaction building (used by SubbitMan)       |
| `@noble/ed25519`         | Ed25519 key generation, signing, verification                      |
| `@noble/hashes`          | Blake2b hashing (key hashes, ToS integrity)                        |
| `cbor2`                  | CBOR encoding for credential serialization                         |
| `@subbit-tx/tx`          | Subbit validator contract bindings and transaction builders        |
| `zod`                    | Runtime schema validation for API responses and key files          |
| `@tanstack/table-core`   | Data table for feeds display                                       |
| `bits-ui`                | Headless UI primitives (used by shadcn-svelte)                     |

### Browser polyfills

The Mesh SDK depends on Node.js built-ins (`crypto`, `buffer`, `stream`). The Vite config includes `vite-plugin-node-polyfills` to provide browser-compatible shims. A custom Vite plugin also pre-bundles `@meshsdk/core` with esbuild to work around Rollup circular dependency issues with `@cardano-sdk/*`.

## Experimental Features

Two SvelteKit/Svelte experimental features are used:

1. **Remote functions** (`kit.experimental.remoteFunctions` in `svelte.config.js`) — server functions callable from client code. This is the primary client-server communication pattern.

2. **Async components** (`compilerOptions.experimental.async` in `svelte.config.js`) — enables `await` in Svelte component markup. Used sparingly for async initialization flows.

Both features are experimental and may change in future SvelteKit/Svelte releases.

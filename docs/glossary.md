# Glossary

Key terms and concepts used throughout the Orcfax On-Demand codebase and documentation.

## Blockchain & Cardano

**ADA** — the native currency of the Cardano blockchain. 1 ADA = 1,000,000 lovelace.

**Lovelace** — the smallest unit of ADA. Named after Ada Lovelace. All internal accounting in the codebase uses lovelace (as `bigint`).

**UTxO** — Unspent Transaction Output. Cardano's accounting model. Each UTxO is like a "coin" with a value and optional attached data (datum). Spending a UTxO consumes it entirely and creates new UTxOs.

**Datum** — data attached to a UTxO, readable by smart contracts. Subbit channels use inline datums to store channel parameters (tag, keys, close period, stage).

**Plutus / Aiken** — smart contract languages for Cardano. The Subbit validator is written in Aiken (source in `services/subbit-xyz/aik/`).

**Reference script** — a smart contract published to the blockchain in a UTxO so that transactions can reference it without including the full script. Saves transaction fees and size. The `PUBLIC_SUBBIT_REFERENCE_UTXO` env var points to the Subbit validator's reference script.

**Blockfrost** — a hosted API for interacting with the Cardano blockchain. Provides UTxO lookups, transaction submission, and chain indexing. Used by both the web app and SubbitMan.

**CIP-30** — the Cardano Improvement Proposal defining how browser wallet extensions communicate with web apps. Standardizes wallet detection, connection, address retrieval, and transaction signing.

## Subbit Protocol

**Subbit** — an L2 (Layer 2) payment channel protocol on Cardano. Enables off-chain micro-payments secured by on-chain escrow. Named as a portmanteau of "sub-bit" (sub-transaction payments).

**L1** — Layer 1. The on-chain Cardano blockchain. Where channels are opened, settled, and closed via transactions.

**L2** — Layer 2. The off-chain accounting layer managed by SubbitMan. Where IOUs are tracked and balances computed between L1 transactions.

**Payment channel** — a mechanism for making many small payments between two parties using only a few on-chain transactions. The consumer locks funds in escrow (L1), exchanges signed payment authorizations off-chain (L2), and then settles on-chain when done.

**Escrow** — ADA locked in the Subbit smart contract UTxO. The consumer controls these funds through signed IOUs. The provider can only claim what the consumer has explicitly authorized.

**Channel reserve** — the minimum ADA (2 ADA) that must remain in a channel's UTxO. This is a Cardano protocol requirement (min-UTxO), not a fee. Returned to the consumer on withdrawal.

**SubbitMan** — the provider-side Subbit channel manager service (`services/subbit-man-js`). A Fastify + LevelDB backend that tracks L2 state, validates credentials, builds L1 transactions, and runs the automated liaison loop.

**Liaison loop** — SubbitMan's automated background process that periodically syncs chain state, detects closed channels, submits settlement transactions, and claims owed funds.

## Credentials & Cryptography

**IOU** — "I Owe You." A signed payment authorization. Contains the channel tag and a cumulative lovelace amount. The provider can claim up to this amount when settling on-chain. IOUs are monotonically increasing — each new IOU replaces the previous one with a higher cumulative total.

**Stamp** — a signed proof of channel ownership. Contains the channel tag and a timestamp. Used for free operations (e.g., checking channel state). The server validates that the timestamp is recent.

**Fixed** — a deterministic credential type. Contains the channel tag and a seed value. Used for specific deterministic use cases.

**Credential (Cred)** — the bundle sent with authenticated API requests. Contains: the Ed25519 public key, the message (IOU, Stamp, or Fixed), and the Ed25519 signature. Serialized as CBOR, then base64url-encoded for the `X-Credential` HTTP header.

**Ed25519** — an elliptic curve digital signature algorithm. Used for signing IOUs and stamps. The consumer generates a keypair when opening a channel; the public key is embedded in the channel's on-chain datum.

**Blake2b** — a cryptographic hash function. Used for key hashes (Blake2b-224 for Cardano payment key hashes) and ToS integrity verification (Blake2b-256).

**CBOR** — Concise Binary Object Representation. A binary serialization format used by Cardano. Credentials are CBOR-encoded before base64url encoding. The codebase uses CBOR tags to distinguish message types: 121 (IOU), 122 (Stamp), 123 (Fixed).

**Bech32** — a human-readable encoding format. Cardano addresses and keys use bech32 with specific prefixes: `ed25519_sk` (signing key), `ed25519_vk` (verification key), `addr` / `addr_test` (addresses).

## Channel Lifecycle

**Channel tag** — a random identifier (up to 20 bytes) that distinguishes channels. Combined with the public key to form the keytag.

**Keytag** — the concatenation of the Ed25519 public key (hex) and the channel tag. Uniquely identifies a channel across the system. Used as the primary key in SubbitMan's LevelDB.

**Channel stages**:

- **Opening** — transaction submitted but not yet confirmed on-chain
- **Open** — active and ready for use. Consumer can make requests and sign IOUs
- **Closing** — close transaction submitted, waiting for confirmation
- **Closed** — settlement window active. Provider may settle
- **Settled** — provider has claimed authorized funds. Consumer can withdraw remainder
- **Ended** — consumer has reclaimed remaining funds. Channel UTxO destroyed

**Settlement window / Close period** — the time between closing a channel and the deadline for provider settlement. Currently 1 hour (3,600,000 ms) per the ToS. If the provider doesn't settle within this window, the consumer can expire the channel.

**Settle** — the provider submits a transaction claiming authorized funds (up to the latest IOU amount) from the channel's escrow.

**End** — the consumer submits a transaction reclaiming remaining funds after provider settlement.

**Expire** — the consumer submits a transaction reclaiming **all** funds after the settlement deadline passes without provider action. This is the consumer's safety net.

## Accounting

**cost** — the actual amount (lovelace) the consumer owes for services rendered. Increases with each charged request.

**iouAmt** — the maximum amount (lovelace) the consumer has authorized via their latest IOU. Must be >= `cost` for requests to be accepted.

**sub** — the amount (lovelace) already settled/deducted on L1.

**subbitAmt** — the total ADA (lovelace) locked in the L1 UTxO.

**Available balance** — what the consumer can still spend: `subbitAmt - cost - CHANNEL_RESERVE`.

## Application Architecture

**Remote functions** — SvelteKit experimental feature. Server-side TypeScript functions in `*.remote.ts` files that can be called directly from client code. Used as the primary client-server communication pattern in the portal.

**Runes** — Svelte 5's reactivity primitives. `$state` declares reactive variables, `$derived` computes derived values, `$effect` runs side effects. Replaces Svelte 4's `$:` reactive statements and stores.

**Context API** — Svelte's `createContext()` + `setContext()`/`getContext()` for dependency injection. The app creates six reactive singletons (NetworkState, Wallet, AuthKey, ChannelStore, Channel, ODAPI) in the layout and injects them into the component tree.

**shadcn-svelte** — a component library built on Bits UI (headless primitives) + Tailwind CSS. Provides buttons, cards, dialogs, tables, etc. Components live in `src/lib/components/ui/`.

## Data & Oracle

**ODAPI** — Orcfax On-Demand API. The system for accessing Orcfax oracle price feeds.

**Feed** — a price pair identifier, e.g., `ADA-USD`, `ADA-DJED`. Represents a specific data stream from the Orcfax validator.

**Orcfax validator node** — the upstream server that provides real-time price data and on-chain publication capabilities. The SvelteKit server proxies requests to it.

**Publish** — writing a price datum to the Cardano blockchain via the Orcfax validator. Creates an on-chain record with the price value, timestamp, and archival metadata. Costs 5 ADA per request.

**Update** — fetching the latest off-chain price from the Orcfax validator. Does not create an on-chain record. Costs 0.01 ADA per request.

## Terms of Service

**ToS** — Terms of Service. A versioned JSON document (`src/lib/tos/tos.json`) defining pricing, channel parameters, and legal clauses.

**Grace period** — when the ToS is updated, a window (currently 7 days) during which previous pricing still applies. Gives consumers time to review changes and decide whether to continue or close their channel.

**ToS hash** — Blake2b-256 hash of the ToS JSON. Included in key files and API response headers for integrity verification.

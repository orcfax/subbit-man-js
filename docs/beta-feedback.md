# Beta Tester Feedback Breakdown — ODAPI Portal Prototype

**Date:** February 19, 2026
**Testers:** TNT, BICH, neal-morrison, punkr_net, ktop_pool (Discord)
**Environment:** Preview testnet, hosted instance with password gate

---

## Tester: TNT

| #   | Feedback                                                                                                                                    | Category | Status                   | Notes                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Failed to open channel** — received a "Failed to open channel" error when attempting to open a payment channel.                           | Bug / UX | **Resolved (user-side)** | Root cause was insufficient funds in the preview testnet wallet. The portal's error message was unclear — it showed a generic failure rather than surfacing the underlying "not enough funds" error from the wallet. Error messaging on the UI was noted as needing improvement. TNT confirmed the issue was resolved after funding the wallet. |
| 2   | **Currency format incorrect** — ADA-denominated price pairs (FACT/ADA, CBLP/ADA) were displaying prices with a `$` prefix instead of `ADA`. | Bug      | **Fixed**                | Acknowledged and fix was pushed shortly after report.                                                                                                                                                                                                                                                                                           |
| 3   | **BTC and ETH prices not publishing on-chain** — after fetching prices, BTC-USD and ETH-USD feeds were not publishing to the chain.         | Bug      | **In progress**          | TNT shared browser console screenshots. Review found only harmless eternl wallet warnings — no portal-side errors. Likely a backend/validator issue rather than a portal bug. Under active investigation.                                                                                                                                       |

---

## Tester: BICH

| #   | Feedback                                                                                                                                                                                                                                                                          | Category             | Status                | Notes                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | **App froze / PC got stuck** — the app became unresponsive, showing a Svelte `{#each key_dup}` error in the console. Had to restart the app to recover.                                                                                                                           | Bug                  | **Fixed**             | Root cause was duplicate item IDs in the data table. Resolved.                                                                                                                                                                                                                                                                                                                                          |
| 5   | **History lists become too large** — expanded feed history rows grow unbounded with no way to see only the most recent entries, making the UI unwieldy.                                                                                                                           | UX / Feature request | **Fixed**             | Addressed with nested table pagination in the expanded row view.                                                                                                                                                                                                                                                                                                                                        |
| 6   | **Suggestion: scheduled/recurring price fetches** — suggested adding the option to request price updates at a given frequency for specific pairs.                                                                                                                                 | Feature request      | **Already addressed** | Tester was pointed to the existing API integration in the sidebar, which allows custom feed price fetches/publishes at any desired frequency.                                                                                                                                                                                                                                                           |
| 7   | **Close channel error + stuck on "Closing in progress"** — attempted to close the channel, received an error, and the UI was stuck on "Closing in progress" indefinitely. After restarting, the wallet showed the correct balance but 100 tADA appeared missing from the channel. | Bug / UX             | **Fixed**             | The error was due to preview testnet tx latency combined with unclear UI. The "missing" funds and "stuck" state were expected Subbit protocol behavior — closing initiates a 24hr settlement period where the provider settles outstanding IOUs before the consumer can withdraw. Addressed with improved close UI/UX and better error handling that communicates the multi-step close process clearly. |

---

## Summary

| Metric               | Count                                                                         |
| -------------------- | ----------------------------------------------------------------------------- |
| Total feedback items | 7                                                                             |
| Fixed                | 4 (#2 currency format, #4 table freeze, #5 history pagination, #7 close flow) |
| Resolved (user-side) | 1 (#1 insufficient funds)                                                     |
| In progress          | 1 (#3 publish failure)                                                        |
| Already addressed    | 1 (#6 recurring fetches existed)                                              |

## Additional Beta Testers

The following testers also participated in beta testing the hosted preview testnet deployment: **neal-morrison**, **punkr_net**, **ktop_pool**.

## Relevance to Catalyst Milestone 4 Acceptance Criteria

This feedback directly satisfies **Acceptance Criterion #4**: _"Early iteration has been used by beta users with feedback given."_ Five independent beta testers used the hosted preview testnet deployment, exercised the core user flows (wallet connection, channel opening, price fetching, on-chain publishing, channel closing), and provided actionable feedback that led to bug fixes and UX improvements. The majority of reported issues have been resolved.

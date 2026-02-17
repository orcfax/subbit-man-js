/**
 * Pure decision functions for the liaison cycle.
 * No I/O — easily testable.
 */

/**
 * Should the provider settle a closed channel?
 * True if the channel is Closed AND has a valid IOU with amount > 0.
 *
 * @param {"Opened" | "Closed" | "Settled"} channelStateKind - On-chain state kind
 * @param {{ iouAmt?: string, sig?: string } | undefined} iouData - IOU data from DB
 * @returns {boolean}
 */
export function shouldSettle(channelStateKind, iouData) {
  if (channelStateKind !== "Closed") return false;
  if (!iouData) return false;
  const amt = BigInt(iouData.iouAmt || "0");
  if (amt <= 0n) return false;
  if (!iouData.sig) return false;
  return true;
}

/**
 * Should the provider submit a sub (claim) for an open channel?
 * True if the IOU amount exceeds current sub + threshold AND a signature exists.
 *
 * @param {{ iouAmt?: string, sig?: string }} iouData - IOU data from DB
 * @param {bigint} currentSub - Current subbed amount on-chain
 * @param {bigint} threshold - Minimum delta to justify a sub tx (lovelace)
 * @returns {boolean}
 */
export function shouldSub(iouData, currentSub, threshold) {
  if (!iouData) return false;
  if (!iouData.sig) return false;
  const iouAmt = BigInt(iouData.iouAmt || "0");
  if (iouAmt <= currentSub + threshold) return false;
  return true;
}

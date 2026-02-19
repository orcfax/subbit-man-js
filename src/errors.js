/**
 * Safe BigInt conversion for user-supplied values.
 * @param {string} value
 * @param {string} fieldName
 * @returns {{ ok: true, value: bigint } | { ok: false, message: string }}
 */
export function parseBigIntSafe(value, fieldName) {
  try {
    return { ok: true, value: BigInt(value) };
  } catch {
    return {
      ok: false,
      message: `Invalid ${fieldName}: "${value}" is not a valid integer.`,
    };
  }
}

const NETWORK_PATTERNS = [
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "fetch failed",
  "rate limit",
  "429",
];

const BLOCKFROST_5XX = /Blockfrost.*5\d{2}|5\d{2}.*Blockfrost/i;

/**
 * Detect network/infrastructure errors vs application errors.
 * @param {Error} error
 * @returns {boolean}
 */
export function isNetworkError(error) {
  const msg = String(error?.message ?? "");
  const cause = String(error?.cause ?? "");
  const combined = `${msg} ${cause}`;

  if (NETWORK_PATTERNS.some((p) => combined.includes(p))) return true;
  if (BLOCKFROST_5XX.test(combined)) return true;

  return false;
}

/**
 * Parse Lucid Evolution / Cardano transaction errors into structured responses.
 * Always logs the raw error before returning.
 *
 * @param {Error} error
 * @param {{ error: (...args: any[]) => void }} log - Fastify logger
 * @returns {{ statusCode: number, message: string }}
 */
export function parseLucidError(error, log) {
  log.error(error);

  const msg = String(error?.message ?? "");

  if (msg.includes("not have enough funds") && msg.includes("collateral")) {
    return {
      statusCode: 400,
      message:
        "Your wallet does not have enough ADA for transaction collateral.",
    };
  }

  if (msg.includes("not have enough funds")) {
    return {
      statusCode: 400,
      message:
        "Your wallet does not have enough ADA to cover this transaction. Try a smaller amount.",
    };
  }

  if (msg.includes("minimum ADA") || msg.includes("minAda")) {
    return {
      statusCode: 400,
      message:
        "Not enough ADA for the minimum change output. Try a smaller amount.",
    };
  }

  if (msg.includes("EMPTY_UTXO") || msg.includes("No UTxO")) {
    return {
      statusCode: 400,
      message:
        "No UTxOs available. If you recently submitted a transaction, wait for confirmation.",
    };
  }

  if (isNetworkError(error)) {
    return {
      statusCode: 503,
      message: "Unable to reach the Cardano network. Try again shortly.",
    };
  }

  if (BLOCKFROST_5XX.test(msg)) {
    return {
      statusCode: 503,
      message: "Cardano network indexer temporarily unavailable.",
    };
  }

  return {
    statusCode: 500,
    message: "Transaction could not be built. Please try again.",
  };
}

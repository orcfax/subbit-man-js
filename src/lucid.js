import fastifyPlugin from "fastify-plugin";
import * as lucid from "@lucid-evolution/lucid";
import * as tx from "@subbit-tx/tx";

/**
 * @typedef LucidContext
 * @type {object}
 * @property {lucid.LucidEvolution} lucid
 * @property {string} validatorAddress
 * @property {lucid.UTxO | null} validatorRef
 * @property {tx.validator.Validator} validator
 * @property {object} config
 * @property {string} config.BLOCKFROST_API_KEY
 * @property {string} config.BLOCKFROST_NETWORK
 * @property {string} config.PROVIDER_KEY_HASH
 * @property {string} config.PROVIDER_SIGNING_KEY
 * @property {boolean} config.ENABLE_IOU_PROCESSING
 * @property {string} config.SUBBIT_REFERENCE_UTXO
 * @property {boolean} config.DRY_RUN
 */

/**
 * @import { FastifyInstance } from "fastify";
 * @param {FastifyInstance} fastify
 */
async function lucidPlugin(fastify) {
  const env = (/** @type {string} */ key, /** @type {string} */ fallback) =>
    process.env[`SUBBIT_MAN_${key}`] ?? fallback;

  const config = {
    BLOCKFROST_API_KEY: env("BLOCKFROST_API_KEY", ""),
    BLOCKFROST_NETWORK: env("BLOCKFROST_NETWORK", "Preview"),
    PROVIDER_KEY_HASH: env("PROVIDER_KEY_HASH", ""),
    PROVIDER_SIGNING_KEY: env("PROVIDER_SIGNING_KEY", ""),
    ENABLE_IOU_PROCESSING: env("ENABLE_IOU_PROCESSING", "false") === "true",
    SUBBIT_REFERENCE_UTXO: env("SUBBIT_REFERENCE_UTXO", ""),
    DRY_RUN: env("DRY_RUN", "false") === "true",
  };

  if (!config.BLOCKFROST_API_KEY) {
    fastify.log.warn(
      "SUBBIT_MAN_BLOCKFROST_API_KEY not set — L1 routes will be unavailable",
    );
    return;
  }

  const network =
    config.BLOCKFROST_NETWORK.toLowerCase() === "mainnet"
      ? "Mainnet"
      : "Preview";

  const provider = new lucid.Blockfrost(
    `https://cardano-${config.BLOCKFROST_NETWORK.toLowerCase()}.blockfrost.io/api/v0`,
    config.BLOCKFROST_API_KEY,
  );

  const l = await lucid.Lucid(provider, network);

  // Initialize validator
  const validator = new tx.validator.Validator();
  const validatorHash = lucid.validatorToScriptHash(validator);
  const validatorAddress = tx.validator.mkAddress(network, validatorHash);

  // Set wallet if IOU processing is enabled
  if (config.ENABLE_IOU_PROCESSING && config.PROVIDER_SIGNING_KEY) {
    l.selectWallet.fromPrivateKey(config.PROVIDER_SIGNING_KEY);
    fastify.log.info("Provider wallet loaded for IOU processing");
  }

  // Fetch reference script if configured
  /** @type {lucid.UTxO | null} */
  let validatorRef = null;
  const refUtxo = config.SUBBIT_REFERENCE_UTXO;
  if (refUtxo) {
    const [txHash, outputIndex] = refUtxo.split("#");
    if (txHash && outputIndex) {
      try {
        const refs = await l.utxosByOutRef([
          { txHash, outputIndex: parseInt(outputIndex, 10) },
        ]);
        if (refs.length > 0) {
          validatorRef = refs[0];
          fastify.log.info(`Reference script loaded: ${refUtxo}`);
        } else {
          fastify.log.warn(`No UTxO found for reference script: ${refUtxo}`);
        }
      } catch (error) {
        fastify.log.warn(`Could not fetch reference script: ${refUtxo}`);
      }
    }
  }

  /** @type {LucidContext} */
  const ctx = {
    lucid: l,
    validatorAddress,
    validatorRef,
    validator,
    config,
  };

  fastify.decorate("lucidCtx", ctx);

  fastify.log.info(`Lucid initialized — network: ${network}`);
  fastify.log.info(`Validator address: ${validatorAddress}`);
}

export default fastifyPlugin(lucidPlugin);

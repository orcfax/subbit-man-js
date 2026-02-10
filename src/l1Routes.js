import * as tx from "@subbit-tx/tx";

/**
 * @import { FastifyInstance } from "fastify";
 * @param {FastifyInstance} fastify
 */
async function l1Routes(fastify) {
  // Guard: skip if Lucid was not initialised (missing Blockfrost key)
  if (!fastify.lucidCtx) {
    fastify.log.warn("Lucid not initialised — L1 routes skipped");
    return;
  }

  // ──────────────────────────────────────────────────
  // POST /l1/build-add
  // Build an unsigned "Add" transaction to add funds to an existing channel
  // ──────────────────────────────────────────────────
  fastify.post(
    "/l1/build-add",
    {
      schema: {
        body: {
          type: "object",
          required: ["tag", "amount", "walletUtxos", "changeAddress"],
          properties: {
            tag: { type: "string" },
            amount: { type: "string" },
            walletUtxos: { type: "array" },
            changeAddress: { type: "string" },
          },
        },
      },
    },
    async function (req, res) {
      const { tag, amount, walletUtxos, changeAddress } = req.body;
      const { lucid: l, validatorAddress, validatorRef } = fastify.lucidCtx;

      const amountBigInt = BigInt(amount);
      if (amountBigInt <= 0n) {
        return res.badRequest("Amount must be greater than 0");
      }

      // Fetch channel UTxO by tag
      let subbit;
      try {
        subbit = await tx.validator.getStateByTag(l, validatorAddress, tag);
      } catch {
        return res.notFound(
          `Channel with tag "${tag}" not found on-chain.`,
        );
      }

      if (subbit.state.kind !== "Opened") {
        return res.badRequest(
          `Channel is not in Opened state. Current state: ${subbit.state.kind}.`,
        );
      }

      // Convert MeshJS UTxO format → Lucid format
      const lucidUtxos = walletUtxos.map((utxo) => {
        const assets = {};
        for (const asset of utxo.output.amount) {
          assets[asset.unit] = BigInt(asset.quantity);
        }
        return {
          txHash: utxo.input.txHash,
          outputIndex: utxo.input.outputIndex,
          address: utxo.output.address,
          assets,
        };
      });

      l.selectWallet.fromAddress(changeAddress, lucidUtxos);

      // Build transaction
      let txBuilder;
      if (validatorRef) {
        txBuilder = await tx.txs.add.single(
          l,
          validatorRef,
          subbit,
          amountBigInt,
        );
      } else {
        const redeemer = tx.validator.addRed();
        txBuilder = tx.txs.add.step(
          l.newTx(),
          subbit.utxo,
          subbit.state.value,
          amountBigInt,
          redeemer,
        );
      }

      const unsignedTx = await txBuilder.complete({ changeAddress });
      const unsignedTxCbor = unsignedTx.toCBOR();

      const opened = subbit.state.value;
      const channelInfo = {
        txId: subbit.utxo.txHash,
        outputIdx: String(subbit.utxo.outputIndex),
        stage: "open",
        cost: String(opened.subbed),
        iouAmt: String(opened.subbed),
        sub: String(opened.subbed),
        subbitAmt: String(opened.amt + amountBigInt),
        sig: "",
      };

      return { unsignedTx: unsignedTxCbor, channelInfo };
    },
  );

  // ──────────────────────────────────────────────────
  // POST /l1/sync-from-chain
  // Fetch open channels from L1 and sync them with the local DB
  // ──────────────────────────────────────────────────
  fastify.post(
    "/l1/sync-from-chain",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            providerKeyHash: { type: "string" },
          },
        },
      },
    },
    async function (req, res) {
      const { lucid: l, validatorAddress, config } = fastify.lucidCtx;
      const providerKeyHash =
        req.body?.providerKeyHash || config.PROVIDER_KEY_HASH;

      if (!providerKeyHash) {
        return res.badRequest("No provider key hash configured or provided");
      }

      // Retry fetching states to handle Blockfrost indexing delays
      let subbits = [];
      const maxAttempts = 5;
      const delayMs = 3000;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        subbits = await tx.validator.getStates(l, validatorAddress);
        fastify.log.info(
          `[sync-from-chain] Attempt ${attempt}/${maxAttempts}: Found ${subbits.length} subbits`,
        );
        if (subbits.length > 0) break;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      const openedChannels = subbits
        .filter((s) => s.state.kind === "Opened")
        .filter(
          (s) =>
            s.state.kind === "Opened" &&
            s.state.value.constants.provider === providerKeyHash,
        );

      if (openedChannels.length === 0) {
        return {
          success: false,
          message: "No channels found to sync",
          timestamp: new Date().toISOString(),
        };
      }

      const channelsForSync = openedChannels
        .map(formatChannelForSync)
        .filter(Boolean);

      if (config.DRY_RUN) {
        return {
          success: true,
          message: "DRY RUN — Would sync channels",
          channelCount: channelsForSync.length,
          timestamp: new Date().toISOString(),
        };
      }

      // POST to the existing /l1/sync endpoint (same Fastify instance)
      const syncRes = await fastify.inject({
        method: "POST",
        url: "/l1/sync",
        payload: channelsForSync,
      });

      return {
        success: syncRes.statusCode < 400,
        message: "Channels synced",
        channelCount: channelsForSync.length,
        syncResult: JSON.parse(syncRes.payload),
        timestamp: new Date().toISOString(),
      };
    },
  );

  // ──────────────────────────────────────────────────
  // POST /l1/process-ious
  // Process pending IOUs: build, sign & submit sub transactions
  // ──────────────────────────────────────────────────
  fastify.post("/l1/process-ious", async function (req, res) {
    const { lucid: l, validatorAddress, validatorRef, config } =
      fastify.lucidCtx;

    if (!config.ENABLE_IOU_PROCESSING) {
      return { processed: 0, successful: 0, failed: 0 };
    }

    // Fetch pending IOUs from local DB
    const ious = await fastify.getIous();

    if (Object.keys(ious).length === 0) {
      return { processed: 0, successful: 0, failed: 0 };
    }

    const results = [];

    for (const [keytag, iouData] of Object.entries(ious)) {
      try {
        if (!iouData.txId || iouData.outputIdx === undefined) {
          results.push({
            keytag,
            success: false,
            error: "Missing UTXO reference",
          });
          continue;
        }

        const utxos = await l.utxosAt(validatorAddress);
        const utxo = utxos.find(
          (u) =>
            u.txHash === iouData.txId &&
            u.outputIndex === parseInt(iouData.outputIdx, 10),
        );

        if (!utxo) {
          results.push({
            keytag,
            success: false,
            error: `UTXO not found: ${iouData.txId}#${iouData.outputIdx}`,
          });
          continue;
        }

        const subbit = tx.validator.utxo2Subbit(utxo);
        if (!subbit || subbit.state.kind !== "Opened") {
          results.push({
            keytag,
            success: false,
            error: "Channel is not in Opened state",
          });
          continue;
        }

        const iouAmount = BigInt(iouData.iouAmt);
        const iouSignature = iouData.sig;

        let txBuilder;
        if (validatorRef) {
          txBuilder = await tx.txs.sub.single(
            l,
            validatorRef,
            subbit,
            iouAmount,
            iouSignature,
          );
        } else {
          const redeemer = tx.validator.subRed(iouAmount, iouSignature);
          txBuilder = tx.txs.sub.step(
            l.newTx(),
            utxo,
            subbit.state.value,
            iouAmount,
            redeemer,
          );
        }

        const unsignedTx = await txBuilder.complete();

        if (config.DRY_RUN) {
          results.push({ keytag, success: true });
          continue;
        }

        const signedTx = await unsignedTx.sign.withWallet().complete();
        const txHash = await signedTx.submit();
        await l.awaitTx(txHash);

        results.push({ keytag, success: true, txHash });
      } catch (error) {
        results.push({ keytag, success: false, error: error.message });
      }
    }

    const successful = results.filter((r) => r.success).length;

    // Sync after successful processing
    if (successful > 0) {
      try {
        await fastify.inject({
          method: "POST",
          url: "/l1/sync-from-chain",
          payload: {},
        });
      } catch (err) {
        fastify.log.warn(`Post-IOU sync failed: ${err.message}`);
      }
    }

    return {
      processed: results.length,
      successful,
      failed: results.length - successful,
      results,
      timestamp: new Date().toISOString(),
    };
  });

  // ──────────────────────────────────────────────────
  // POST /l1/utxos
  // Fetch UTxOs by output references
  // ──────────────────────────────────────────────────
  fastify.post(
    "/l1/utxos",
    {
      schema: {
        body: {
          type: "object",
          required: ["outRefs"],
          properties: {
            outRefs: {
              type: "array",
              items: {
                type: "object",
                required: ["txHash", "outputIndex"],
                properties: {
                  txHash: { type: "string" },
                  outputIndex: { type: "integer" },
                },
              },
            },
          },
        },
      },
    },
    async function (req, res) {
      const { lucid: l } = fastify.lucidCtx;
      const utxos = await l.utxosByOutRef(req.body.outRefs);
      return { utxos };
    },
  );
}

/**
 * Format a Subbit for the /l1/sync endpoint
 * @param {tx.validator.Subbit} subbit
 */
function formatChannelForSync(subbit) {
  const { utxo, state } = subbit;
  if (state.kind !== "Opened") return null;

  const { constants, subbed, amt } = state.value;

  let currency = "Ada";
  if (constants.currency !== "Ada") {
    if (typeof constants.currency === "object" && "ByHash" in constants.currency) {
      currency = { byHash: constants.currency.ByHash };
    } else if (
      typeof constants.currency === "object" &&
      "ByClass" in constants.currency
    ) {
      currency = { byClass: constants.currency.ByClass };
    }
  }

  return {
    txId: utxo.txHash,
    outputIdx: String(utxo.outputIndex),
    provider: constants.provider,
    currency,
    closePeriod: String(constants.closePeriod),
    iouKey: constants.iouKey,
    tag: constants.tag,
    subbitAmt: String(amt),
    sub: String(subbed),
  };
}

export default l1Routes;

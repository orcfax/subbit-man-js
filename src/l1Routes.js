import * as tx from "@subbit-tx/tx";
import * as keys from "./db/keys.js";
import { parseBigIntSafe, isNetworkError, parseLucidError } from "./errors.js";

/**
 * @import { FastifyInstance } from "fastify";
 * @param {FastifyInstance} fastify
 */
/** Convert a raw UTF-8 tag string to the hex encoding used on-chain. */
function tagToHex(tag) {
  return Buffer.from(tag, "utf8").toString("hex");
}

async function l1Routes(fastify) {
  // Guard: skip if Lucid was not initialised (missing Blockfrost key)
  if (!fastify.lucidCtx) {
    fastify.log.warn("Lucid not initialised — L1 routes skipped");
    return;
  }

  // ──────────────────────────────────────────────────
  // POST /l1/build-open
  // Build an unsigned "Open" transaction to create a new channel
  // ──────────────────────────────────────────────────
  fastify.post(
    "/l1/build-open",
    {
      schema: {
        body: {
          type: "object",
          required: [
            "tag",
            "amount",
            "iouKey",
            "consumerKeyHash",
            "walletUtxos",
            "changeAddress",
          ],
          properties: {
            tag: { type: "string" },
            amount: { type: "string" },
            iouKey: { type: "string" },
            consumerKeyHash: { type: "string" },
            walletUtxos: { type: "array" },
            changeAddress: { type: "string" },
          },
        },
      },
    },
    async function (req, res) {
      const { tag, amount, iouKey, consumerKeyHash, walletUtxos, changeAddress } =
        req.body;
      const { lucid: l, validatorRef, config } = fastify.lucidCtx;

      const parsed = parseBigIntSafe(amount, "amount");
      if (!parsed.ok) return res.badRequest(parsed.message);
      const amountBigInt = parsed.value;
      if (amountBigInt <= 0n) {
        return res.badRequest("Amount must be greater than 0");
      }

      if (!validatorRef) {
        return res.badRequest(
          "Validator reference script not configured. Set SUBBIT_MAN_SUBBIT_REFERENCE_UTXO.",
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

      // Build constants for the channel datum
      const constants = {
        tag: tagToHex(tag),
        currency: "Ada",
        iouKey: iouKey,
        consumer: consumerKeyHash,
        provider: config.PROVIDER_KEY_HASH,
        closePeriod: 86400000n,
      };

      // Build transaction
      let unsignedTxCbor;
      try {
        const txBuilder = await tx.txs.open.tx(
          l,
          validatorRef,
          constants,
          amountBigInt,
        );

        const unsignedTx = await txBuilder.complete({ changeAddress });
        unsignedTxCbor = unsignedTx.toCBOR();
      } catch (err) {
        const { statusCode, message } = parseLucidError(err, fastify.log);
        return res.status(statusCode).send({
          statusCode,
          error: statusCode >= 500 ? "Internal Server Error" : "Bad Request",
          message,
        });
      }

      const channelInfo = {
        txId: "",
        outputIdx: "0",
        stage: "open",
        cost: "0",
        iouAmt: "0",
        sub: "0",
        subbitAmt: String(amountBigInt),
        sig: "",
      };

      return { unsignedTx: unsignedTxCbor, channelInfo };
    },
  );

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

      const parsed = parseBigIntSafe(amount, "amount");
      if (!parsed.ok) return res.badRequest(parsed.message);
      const amountBigInt = parsed.value;
      if (amountBigInt <= 0n) {
        return res.badRequest("Amount must be greater than 0");
      }

      // Fetch channel UTxO by tag
      let subbit;
      try {
        subbit = await tx.validator.getStateByTag(l, validatorAddress, tagToHex(tag));
      } catch (err) {
        if (isNetworkError(err)) {
          const { statusCode, message } = parseLucidError(err, fastify.log);
          return res.status(statusCode).send({ statusCode, error: "Service Unavailable", message });
        }
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
      let unsignedTxCbor;
      try {
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
        unsignedTxCbor = unsignedTx.toCBOR();
      } catch (err) {
        const { statusCode, message } = parseLucidError(err, fastify.log);
        return res.status(statusCode).send({
          statusCode,
          error: statusCode >= 500 ? "Internal Server Error" : "Bad Request",
          message,
        });
      }

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

      // Call putL1 directly per channel instead of POSTing to /l1/sync,
      // which sweeps ALL opened keytags and suspends any not in the payload
      // (causing false suspensions when Blockfrost returns partial results).
      const results = await Promise.all(
        channelsForSync.map((ch) => {
          const keytag = keys.keytag(
            Buffer.from(ch.iouKey, "hex"),
            Buffer.from(ch.tag, "hex"),
          );
          const l1Subbit = {
            txId: Buffer.from(ch.txId, "hex"),
            outputIdx: BigInt(ch.outputIdx),
            subbitAmt: BigInt(ch.subbitAmt),
            sub: BigInt(ch.sub),
          };
          return fastify.putL1(keytag, [l1Subbit]).then(
            (r) => [ch.tag, r.kind === "Right" ? r.value : r.error],
            (err) => [ch.tag, err.message],
          );
        }),
      );

      return {
        success: true,
        message: "Channels synced",
        channelCount: channelsForSync.length,
        syncResult: Object.fromEntries(results),
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

    // Fetch pending IOUs from local DB
    const ious = await fastify.getIous();

    if (Object.keys(ious).length === 0) {
      return { processed: 0, successful: 0, failed: 0 };
    }

    // Fetch all UTxOs at the validator address once
    const allUtxos = await l.utxosAt(validatorAddress);

    const results = [];
    /** @type {Array<{keytag: string, subbit: any, utxo: any, iouAmount: bigint, iouSignature: string}>} */
    const subJobs = [];

    for (const [keytag, iouData] of Object.entries(ious)) {
      if (!iouData.txId || iouData.outputIdx === undefined) {
        results.push({ keytag, success: false, error: "Missing UTXO reference" });
        continue;
      }

      const utxo = allUtxos.find(
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
        results.push({ keytag, success: false, error: "Channel is not in Opened state" });
        continue;
      }

      const iouAmount = BigInt(iouData.iouAmt);
      const iouSignature = iouData.sig;

      // Skip if nothing to claim (iouAmt <= subbed)
      if (iouAmount <= subbit.state.value.subbed) {
        continue;
      }

      if (!iouSignature) {
        results.push({ keytag, success: false, error: "Missing IOU signature" });
        continue;
      }

      subJobs.push({ keytag, subbit, utxo, iouAmount, iouSignature });
    }

    if (subJobs.length === 0) {
      return {
        processed: results.length,
        successful: 0,
        failed: results.filter((r) => !r.success).length,
        results,
        timestamp: new Date().toISOString(),
      };
    }

    // Batch sub via batch.tx() if reference script available
    // TODO: Fee analysis before sub (ensure tx fee doesn't exceed claimed amount)
    if (validatorRef && subJobs.length > 0) {
      try {
        /** @type {import("@subbit-tx/tx").validator.SubbitStep[]} */
        const steps = subJobs.map((job) => ({
          utxo: job.utxo,
          state: job.subbit.state.value,
          step: "sub",
          amt: job.iouAmount,
          sig: job.iouSignature,
        }));

        const txBuilder = await tx.txs.batch.tx(l, validatorRef, steps);
        const unsignedTx = await txBuilder.complete();
        const signedTx = await unsignedTx.sign.withWallet().complete();
        const txHash = await signedTx.submit();

        // Async confirmation
        l.awaitTx(txHash).then(
          () => fastify.log.info(`[process-ious] Batch confirmed: ${txHash}`),
          (err) => fastify.log.warn(`[process-ious] Batch confirmation failed: ${err.message}`),
        );

        for (const job of subJobs) {
          results.push({ keytag: job.keytag, success: true, txHash });
        }
      } catch (error) {
        fastify.log.error(`[process-ious] Batch sub failed: ${error.message}`);
        // On batch failure, log and let the next cycle retry
        for (const job of subJobs) {
          results.push({ keytag: job.keytag, success: false, error: error.message });
        }
      }
    } else {
      // Fallback: single-tx sub per channel
      for (const job of subJobs) {
        try {
          let txBuilder;
          if (validatorRef) {
            txBuilder = await tx.txs.sub.single(
              l,
              validatorRef,
              job.subbit,
              job.iouAmount,
              job.iouSignature,
            );
          } else {
            const redeemer = tx.validator.subRed(job.iouAmount, job.iouSignature);
            txBuilder = tx.txs.sub.step(
              l.newTx(),
              job.utxo,
              job.subbit.state.value,
              job.iouAmount,
              redeemer,
            );
          }

          const unsignedTx = await txBuilder.complete();
          const signedTx = await unsignedTx.sign.withWallet().complete();
          const txHash = await signedTx.submit();
          await l.awaitTx(txHash);

          results.push({ keytag: job.keytag, success: true, txHash });
        } catch (error) {
          results.push({ keytag: job.keytag, success: false, error: error.message });
        }
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
  // POST /l1/build-close
  // Build an unsigned "Close" transaction to close an open channel
  // ──────────────────────────────────────────────────
  fastify.post(
    "/l1/build-close",
    {
      schema: {
        body: {
          type: "object",
          required: ["tag", "walletUtxos", "changeAddress"],
          properties: {
            tag: { type: "string" },
            walletUtxos: { type: "array" },
            changeAddress: { type: "string" },
          },
        },
      },
    },
    async function (req, res) {
      const { tag, walletUtxos, changeAddress } = req.body;
      const { lucid: l, validatorAddress, validatorRef } = fastify.lucidCtx;

      // Fetch channel UTxO by tag
      let subbit;
      try {
        subbit = await tx.validator.getStateByTag(l, validatorAddress, tagToHex(tag));
      } catch (err) {
        if (isNetworkError(err)) {
          const { statusCode, message } = parseLucidError(err, fastify.log);
          return res.status(statusCode).send({ statusCode, error: "Service Unavailable", message });
        }
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
      let unsignedTxCbor;
      try {
        let txBuilder;
        if (validatorRef) {
          txBuilder = await tx.txs.close.single(l, validatorRef, subbit);
        } else {
          const opened = subbit.state.value;
          const now = BigInt(Date.now());
          const redeemer = tx.validator.closeRed();
          txBuilder = tx.txs.close.step(
            l.newTx(),
            subbit.utxo,
            opened,
            now,
            redeemer,
          );
        }

        const unsignedTx = await txBuilder.complete({ changeAddress });
        unsignedTxCbor = unsignedTx.toCBOR();
      } catch (err) {
        const { statusCode, message } = parseLucidError(err, fastify.log);
        return res.status(statusCode).send({
          statusCode,
          error: statusCode >= 500 ? "Internal Server Error" : "Bad Request",
          message,
        });
      }

      // Extract deadline from the built tx output datum
      // close.single computes: deadline = (now + 300_000) + closePeriod + 1001
      const opened = subbit.state.value;
      const now = BigInt(Date.now());
      const deadline = now + 300000n + opened.constants.closePeriod + 1001n;

      return { unsignedTx: unsignedTxCbor, deadline: Number(deadline) };
    },
  );

  // ──────────────────────────────────────────────────
  // POST /l1/build-end
  // Build an unsigned "End" transaction to reclaim funds from a settled channel
  // ──────────────────────────────────────────────────
  fastify.post(
    "/l1/build-end",
    {
      schema: {
        body: {
          type: "object",
          required: ["consumerKeyHash", "walletUtxos", "changeAddress"],
          properties: {
            consumerKeyHash: { type: "string" },
            walletUtxos: { type: "array" },
            changeAddress: { type: "string" },
          },
        },
      },
    },
    async function (req, res) {
      const { consumerKeyHash, walletUtxos, changeAddress } = req.body;
      const { lucid: l, validatorAddress, validatorRef } = fastify.lucidCtx;

      // Find settled channel by consumer key hash
      let settled;
      try {
        settled = await tx.validator.getSettledByConsumer(
          l,
          validatorAddress,
          consumerKeyHash,
        );
      } catch (err) {
        if (isNetworkError(err)) {
          const { statusCode, message } = parseLucidError(err, fastify.log);
          return res.status(statusCode).send({ statusCode, error: "Service Unavailable", message });
        }
        return res.notFound(
          `No settled channel found for consumer "${consumerKeyHash}".`,
        );
      }

      if (settled.length === 0) {
        return res.notFound(
          `No settled channel found for consumer "${consumerKeyHash}".`,
        );
      }

      const subbit = settled[0];

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
      let unsignedTxCbor;
      try {
        let txBuilder;
        if (validatorRef) {
          txBuilder = await tx.txs.end.single(l, validatorRef, subbit);
        } else {
          const consumer = subbit.state.value.consumer;
          const redeemer = tx.validator.endRed();
          txBuilder = tx.txs.end.step(
            l.newTx(),
            subbit.utxo,
            consumer,
            redeemer,
          );
        }

        const unsignedTx = await txBuilder.complete({ changeAddress });
        unsignedTxCbor = unsignedTx.toCBOR();
      } catch (err) {
        const { statusCode, message } = parseLucidError(err, fastify.log);
        return res.status(statusCode).send({
          statusCode,
          error: statusCode >= 500 ? "Internal Server Error" : "Bad Request",
          message,
        });
      }

      return { unsignedTx: unsignedTxCbor };
    },
  );

  // ──────────────────────────────────────────────────
  // POST /l1/build-expire
  // Build an unsigned "Expire" transaction to reclaim all funds after deadline
  // ──────────────────────────────────────────────────
  fastify.post(
    "/l1/build-expire",
    {
      schema: {
        body: {
          type: "object",
          required: ["tag", "walletUtxos", "changeAddress"],
          properties: {
            tag: { type: "string" },
            walletUtxos: { type: "array" },
            changeAddress: { type: "string" },
          },
        },
      },
    },
    async function (req, res) {
      const { tag, walletUtxos, changeAddress } = req.body;
      const { lucid: l, validatorAddress, validatorRef } = fastify.lucidCtx;

      // Fetch channel UTxO by tag
      let subbit;
      try {
        subbit = await tx.validator.getStateByTag(l, validatorAddress, tagToHex(tag));
      } catch (err) {
        if (isNetworkError(err)) {
          const { statusCode, message } = parseLucidError(err, fastify.log);
          return res.status(statusCode).send({ statusCode, error: "Service Unavailable", message });
        }
        return res.notFound(
          `Channel with tag "${tag}" not found on-chain.`,
        );
      }

      if (subbit.state.kind !== "Closed") {
        return res.badRequest(
          `Channel is not in Closed state. Current state: ${subbit.state.kind}.`,
        );
      }

      // Verify deadline has passed
      const closed = subbit.state.value;
      const now = BigInt(Date.now());
      if (now < closed.deadline) {
        return res.badRequest(
          `Deadline has not passed yet. Deadline: ${closed.deadline}, now: ${now}.`,
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
      let unsignedTxCbor;
      try {
        let txBuilder;
        if (validatorRef) {
          txBuilder = await tx.txs.expire.single(l, validatorRef, subbit);
        } else {
          const redeemer = tx.validator.expireRed();
          txBuilder = tx.txs.expire.step(
            l.newTx(),
            subbit.utxo,
            closed,
            now,
            redeemer,
          );
        }

        const unsignedTx = await txBuilder.complete({ changeAddress });
        unsignedTxCbor = unsignedTx.toCBOR();
      } catch (err) {
        const { statusCode, message } = parseLucidError(err, fastify.log);
        return res.status(statusCode).send({
          statusCode,
          error: statusCode >= 500 ? "Internal Server Error" : "Bad Request",
          message,
        });
      }

      return { unsignedTx: unsignedTxCbor };
    },
  );

  // ──────────────────────────────────────────────────
  // POST /l1/channel-on-chain-state
  // Lightweight on-chain state lookup (bypasses LevelDB)
  // ──────────────────────────────────────────────────
  fastify.post(
    "/l1/channel-on-chain-state",
    {
      schema: {
        body: {
          type: "object",
          required: ["tag", "consumerKeyHash"],
          properties: {
            tag: { type: "string" },
            consumerKeyHash: { type: "string" },
          },
        },
      },
    },
    async function (req, res) {
      const { tag, consumerKeyHash } = req.body;
      const { lucid: l, validatorAddress } = fastify.lucidCtx;

      // Step 1: Try getStatesByTag — finds Opened or Closed UTxOs (filters out Settled)
      const byTag = await tx.validator.getStatesByTag(l, validatorAddress, tagToHex(tag));

      if (byTag.length > 0) {
        const subbit = byTag[0];
        if (subbit.state.kind === "Closed") {
          return {
            state: "closed",
            deadline: Number(subbit.state.value.deadline),
          };
        }
        return { state: subbit.state.kind.toLowerCase() };
      }

      // Step 2: Try getSettledByConsumer — Settled datum only stores consumer vkh, not tag
      const settled = await tx.validator.getSettledByConsumer(
        l,
        validatorAddress,
        consumerKeyHash,
      );

      if (settled.length > 0) {
        return { state: "settled" };
      }

      // Step 3: Neither found — UTxO destroyed (End or Expire already happened)
      return { state: "not-found" };
    },
  );

  // ──────────────────────────────────────────────────
  // POST /l1/process-closed-channels
  // Provider-side: auto-settle closed channels (not yet consumed by consumer app)
  // ──────────────────────────────────────────────────
  fastify.post("/l1/process-closed-channels", async function (req, res) {
    const { lucid: l, validatorAddress, validatorRef, config } =
      fastify.lucidCtx;

    if (!config.PROVIDER_KEY_HASH) {
      return res.badRequest("No provider key hash configured");
    }

    // Fetch all on-chain states and filter for Closed channels belonging to this provider
    const subbits = await tx.validator.getStates(l, validatorAddress);
    const closedChannels = subbits.filter(
      (s) =>
        s.state.kind === "Closed" &&
        s.state.value.constants.provider === config.PROVIDER_KEY_HASH,
    );

    if (closedChannels.length === 0) {
      return { processed: 0, successful: 0, failed: 0 };
    }

    // Fetch all IOUs once before the loop
    const ious = await fastify.getIous();
    const results = [];

    // Collect settle steps for batch transaction
    /** @type {Array<{subbit: any, iouAmount: bigint, iouSignature: string, tagHex: string}>} */
    const settleJobs = [];

    for (const subbit of closedChannels) {
      const closed = subbit.state.value;
      const onChainTagHex = closed.constants.tag;

      // Fix: match by comparing keytag suffix (last N chars = tag hex) against on-chain tag
      const iouEntry = Object.entries(ious).find(
        ([keytagHex]) => keytagHex.slice(64) === onChainTagHex,
      );

      if (!iouEntry) {
        results.push({ tag: onChainTagHex, success: false, error: "No IOU found" });
        continue;
      }

      const [, iouData] = iouEntry;
      const iouAmount = BigInt(iouData.iouAmt);
      const iouSignature = iouData.sig;

      if (iouAmount <= 0n || !iouSignature) {
        results.push({ tag: onChainTagHex, success: false, error: "No claimable IOU amount" });
        continue;
      }

      settleJobs.push({ subbit, iouAmount, iouSignature, tagHex: onChainTagHex });
    }

    if (settleJobs.length === 0) {
      return {
        processed: results.length,
        successful: 0,
        failed: results.length,
        results,
        timestamp: new Date().toISOString(),
      };
    }

    // Batch settle via batch.tx() if reference script available and multiple jobs
    if (validatorRef && settleJobs.length > 0) {
      try {
        /** @type {import("@subbit-tx/tx").validator.SubbitStep[]} */
        const steps = settleJobs.map((job) => ({
          utxo: job.subbit.utxo,
          state: job.subbit.state.value,
          step: "settle",
          amt: job.iouAmount,
          sig: job.iouSignature,
        }));

        const txBuilder = await tx.txs.batch.tx(l, validatorRef, steps);
        const unsignedTx = await txBuilder.complete();
        const signedTx = await unsignedTx.sign.withWallet().complete();
        const txHash = await signedTx.submit();

        // Async confirmation
        l.awaitTx(txHash).then(
          () => fastify.log.info(`[process-closed-channels] Batch confirmed: ${txHash}`),
          (err) => fastify.log.warn(`[process-closed-channels] Batch confirmation failed: ${err.message}`),
        );

        for (const job of settleJobs) {
          results.push({ tag: job.tagHex, success: true, txHash });
        }
      } catch (error) {
        fastify.log.error(`[process-closed-channels] Batch settle failed: ${error.message}`);
        for (const job of settleJobs) {
          results.push({ tag: job.tagHex, success: false, error: error.message });
        }
      }
    } else {
      // Fallback: single-tx settle per channel
      for (const job of settleJobs) {
        try {
          let txBuilder;
          if (validatorRef) {
            txBuilder = await tx.txs.settle.single(
              l,
              validatorRef,
              job.subbit,
              job.iouAmount,
              job.iouSignature,
            );
          } else {
            const redeemer = tx.validator.settleRed(job.iouAmount, job.iouSignature);
            txBuilder = tx.txs.settle.step(
              l.newTx(),
              job.subbit.utxo,
              job.subbit.state.value,
              job.iouAmount,
              redeemer,
            );
          }

          const unsignedTx = await txBuilder.complete();
          const signedTx = await unsignedTx.sign.withWallet().complete();
          const txHash = await signedTx.submit();
          await l.awaitTx(txHash);

          results.push({ tag: job.tagHex, success: true, txHash });
        } catch (error) {
          results.push({ tag: job.tagHex, success: false, error: error.message });
        }
      }
    }

    const successful = results.filter((r) => r.success).length;

    return {
      processed: results.length,
      successful,
      failed: results.length - successful,
      results,
      timestamp: new Date().toISOString(),
    };
  });

  // ──────────────────────────────────────────────────
  // POST /l1/settle-channel
  // Settle a specific closed channel by tag (triggered by portal after consumer close)
  // ──────────────────────────────────────────────────
  fastify.post(
    "/l1/settle-channel",
    {
      schema: {
        body: {
          type: "object",
          required: ["tag"],
          properties: {
            tag: { type: "string" },
          },
        },
      },
    },
    async function (req, res) {
      const { tag } = req.body;
      const { lucid: l, validatorAddress, validatorRef, config } =
        fastify.lucidCtx;

      // Sync from chain first to ensure DB state matches L1
      try {
        await fastify.inject({
          method: "POST",
          url: "/l1/sync-from-chain",
          payload: {},
        });
      } catch (err) {
        fastify.log.warn(`[settle-channel] Pre-settle sync failed: ${err.message}`);
      }

      const tagHex = tagToHex(tag);

      // Find the Closed channel on-chain
      let subbit;
      try {
        subbit = await tx.validator.getStateByTag(l, validatorAddress, tagHex);
      } catch {
        return { success: false, error: `Channel with tag "${tag}" not found on-chain` };
      }

      if (subbit.state.kind !== "Closed") {
        return { success: false, error: `Channel is not Closed (state: ${subbit.state.kind})` };
      }

      // Look up IOU from DB — match keytag suffix against on-chain tag hex
      const ious = await fastify.getIous();
      const iouEntry = Object.entries(ious).find(
        ([keytagHex]) => keytagHex.slice(64) === tagHex,
      );

      if (!iouEntry) {
        return { success: false, error: "No IOU found for this channel" };
      }

      const [, iouData] = iouEntry;
      const iouAmount = BigInt(iouData.iouAmt);
      const iouSignature = iouData.sig;

      if (iouAmount <= 0n || !iouSignature) {
        return { success: false, error: "IOU has no claimable amount or missing signature" };
      }

      try {
        // Build settle tx
        let txBuilder;
        if (validatorRef) {
          txBuilder = await tx.txs.settle.single(
            l,
            validatorRef,
            subbit,
            iouAmount,
            iouSignature,
          );
        } else {
          const redeemer = tx.validator.settleRed(iouAmount, iouSignature);
          txBuilder = tx.txs.settle.step(
            l.newTx(),
            subbit.utxo,
            subbit.state.value,
            iouAmount,
            redeemer,
          );
        }

        const unsignedTx = await txBuilder.complete();

        const signedTx = await unsignedTx.sign.withWallet().complete();
        const txHash = await signedTx.submit();

        // Async confirmation — don't block response
        l.awaitTx(txHash).then(
          () => fastify.log.info(`[settle-channel] Confirmed: ${txHash}`),
          (err) => fastify.log.warn(`[settle-channel] Confirmation failed: ${err.message}`),
        );

        return { success: true, txHash, tag };
      } catch (error) {
        fastify.log.error(`[settle-channel] Failed: ${error.message}`);
        return { success: false, error: error.message, tag };
      }
    },
  );

  // ──────────────────────────────────────────────────
  // POST /l1/liaison-run
  // Manual trigger for full liaison cycle
  // ──────────────────────────────────────────────────
  fastify.post("/l1/liaison-run", async function (req, res) {
    if (fastify.runLiaisonCycle) {
      const result = await fastify.runLiaisonCycle("manual");
      return result;
    }

    // Fallback: run steps sequentially via inject
    const results = {};

    try {
      const syncRes = await fastify.inject({
        method: "POST",
        url: "/l1/sync-from-chain",
        payload: {},
      });
      results.sync = JSON.parse(syncRes.payload);
    } catch (err) {
      results.sync = { error: err.message };
    }

    try {
      const settleRes = await fastify.inject({
        method: "POST",
        url: "/l1/process-closed-channels",
        payload: {},
      });
      results.settle = JSON.parse(settleRes.payload);
    } catch (err) {
      results.settle = { error: err.message };
    }

    try {
      const subRes = await fastify.inject({
        method: "POST",
        url: "/l1/process-ious",
        payload: {},
      });
      results.subs = JSON.parse(subRes.payload);
    } catch (err) {
      results.subs = { error: err.message };
    }

    return { trigger: "manual-fallback", results, timestamp: new Date().toISOString() };
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

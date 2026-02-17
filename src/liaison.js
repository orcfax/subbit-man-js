import fastifyPlugin from "fastify-plugin";
import { ToadScheduler, SimpleIntervalJob, AsyncTask } from "toad-scheduler";

/**
 * Liaison plugin — automated cycle that keeps provider state in sync
 * and settles/claims funds from Subbit channels.
 *
 * Config via env vars:
 *   SUBBIT_MAN_LIAISON_ENABLED       (default: "false")
 *   SUBBIT_MAN_SYNC_INTERVAL_MS      (default: "900000" = 15 min)
 *   SUBBIT_MAN_SUB_THRESHOLD_LOVELACE (default: "0" = process all)
 *
 * @import { FastifyInstance } from "fastify";
 * @param {FastifyInstance} fastify
 */
async function liaison(fastify) {
  const env = (/** @type {string} */ key, /** @type {string} */ fallback) =>
    process.env[`SUBBIT_MAN_${key}`] ?? fallback;

  const enabled = env("LIAISON_ENABLED", "false") === "true";

  if (!enabled) {
    fastify.log.info("[liaison] Disabled (set SUBBIT_MAN_LIAISON_ENABLED=true to enable)");
    return;
  }

  // Guard: requires lucidCtx + IOU processing
  if (!fastify.lucidCtx) {
    fastify.log.warn("[liaison] Lucid not initialised — liaison disabled");
    return;
  }

  if (!fastify.lucidCtx.config.ENABLE_IOU_PROCESSING) {
    fastify.log.warn("[liaison] IOU processing not enabled — liaison disabled");
    return;
  }

  const intervalMs = parseInt(env("SYNC_INTERVAL_MS", "900000"), 10);

  let running = false;

  /**
   * Run a full liaison cycle: sync → settle → subs.
   * Decorated onto fastify so endpoints can trigger it.
   * @param {string} trigger - What triggered this cycle (e.g. "scheduled", "manual")
   */
  async function runLiaisonCycle(trigger) {
    if (running) {
      fastify.log.info(`[liaison] Cycle already running, skipping (trigger: ${trigger})`);
      return { skipped: true, reason: "already running" };
    }

    running = true;
    const startTime = Date.now();
    fastify.log.info(`[liaison] Cycle started (trigger: ${trigger})`);

    const results = {};

    try {
      // 1. Sync from chain
      fastify.log.info("[liaison] Step 1/3: Syncing from chain...");
      const syncRes = await fastify.inject({
        method: "POST",
        url: "/l1/sync-from-chain",
        payload: {},
      });
      results.sync = JSON.parse(syncRes.payload);
      fastify.log.info(`[liaison] Sync complete: ${syncRes.statusCode}`);

      // 2. Settle closed channels
      fastify.log.info("[liaison] Step 2/3: Processing closed channels...");
      const settleRes = await fastify.inject({
        method: "POST",
        url: "/l1/process-closed-channels",
        payload: {},
      });
      results.settle = JSON.parse(settleRes.payload);
      fastify.log.info(
        `[liaison] Settle complete: ${results.settle.successful || 0} settled, ${results.settle.failed || 0} failed`,
      );

      // 3. Process IOUs / subs
      fastify.log.info("[liaison] Step 3/3: Processing IOUs...");
      const subRes = await fastify.inject({
        method: "POST",
        url: "/l1/process-ious",
        payload: {},
      });
      results.subs = JSON.parse(subRes.payload);
      fastify.log.info(
        `[liaison] Subs complete: ${results.subs.successful || 0} processed, ${results.subs.failed || 0} failed`,
      );
    } catch (err) {
      fastify.log.error(`[liaison] Cycle error: ${err.message}`);
      results.error = err.message;
    } finally {
      running = false;
      const durationMs = Date.now() - startTime;
      fastify.log.info(`[liaison] Cycle finished in ${durationMs}ms (trigger: ${trigger})`);
    }

    return { trigger, results, durationMs: Date.now() - startTime, timestamp: new Date().toISOString() };
  }

  // Decorate onto fastify so endpoints (liaison-run) can call it
  fastify.decorate("runLiaisonCycle", runLiaisonCycle);

  // Schedule recurring cycle
  const scheduler = new ToadScheduler();

  const task = new AsyncTask("liaison-cycle", () => runLiaisonCycle("scheduled"), (err) => {
    fastify.log.error(`[liaison] Scheduled task error: ${err.message}`);
  });

  const job = new SimpleIntervalJob(
    { milliseconds: intervalMs, runImmediately: false },
    task,
    { id: "liaison-cycle", preventOverrun: true },
  );

  fastify.ready().then(() => {
    scheduler.addSimpleIntervalJob(job);
    fastify.log.info(
      `[liaison] Enabled — cycle every ${intervalMs / 1000}s`,
    );
  });

  // Cleanup on close
  fastify.addHook("onClose", () => {
    scheduler.stop();
    fastify.log.info("[liaison] Scheduler stopped");
  });

  // TODO: Combine subs + settles into a single batch tx per liaison cycle (currently two separate batch txs)
  // TODO: Implement economic threshold logic (skip subs below configurable lovelace amount)
  // TODO: Traffic-triggered sync (after N IOU events, trigger early sync)
}

export default fastifyPlugin(liaison);

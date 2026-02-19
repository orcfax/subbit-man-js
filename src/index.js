import sensible from "@fastify/sensible";
import { defaults } from "./options.js";
import db from "./db/index.js";
import routes from "./routes.js";
import lucidPlugin from "./lucid.js";
import l1Routes from "./l1Routes.js";
import liaison from "./liaison.js";
import * as config from "./config.js";
import { parseLucidError } from "./errors.js";

const options = {
  dbPath: "./db",
  provider: defaults.provider,
  currency: "Ada",
  closePeriod: String(24 * 60 * 60 * 1000),
  tagLength: "20",
  nowThreshold: String(60 * 60 * 1000),
  fixedSeed: defaults.fixedSeed,
  initCost: "1000",
  bodyLimit: 1048576 * 30,
};

/**
 * @import { FastifyInstance, FastifyPluginOptions} from "fastify";
 * @param {FastifyInstance} fastify
 * @param {FastifyPluginOptions & import("./config.js").Options} opts
 */

function main(fastify, opts) {
  const c = config.parseOptions({ ...opts, ...config.env() });
  fastify.register(sensible);
  fastify.register(db, { config: c.db });
  fastify.register(lucidPlugin);
  fastify.register(routes, { config: c.routes });
  fastify.register(l1Routes);
  fastify.register(liaison);

  fastify.setErrorHandler(async function (error, request, reply) {
    if (error.validation) {
      reply.status(400).send({
        statusCode: 400,
        error: "Bad Request",
        message: error.message,
        code: "VALIDATION_ERROR",
      });
      return;
    }

    const parsed = parseLucidError(error, fastify.log);
    reply.status(parsed.statusCode).send({
      statusCode: parsed.statusCode,
      error: parsed.statusCode >= 500 ? "Internal Server Error" : "Bad Request",
      message: parsed.message,
    });
  });
}

export { options };
export default main;

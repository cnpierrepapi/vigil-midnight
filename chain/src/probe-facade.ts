// Reproduce the Wallet.Sync error with full error contents visible.
// Builds the same facade as deploy.ts, subscribes to the state stream,
// and prints any error with util.inspect at depth.
import "dotenv/config";
import util from "node:util";
import pino from "pino";
import pinoPretty from "pino-pretty";

import * as api from "./api";
import { PreprodConfig } from "./config";

const logger = pino(
  { level: process.env.DEBUG_LEVEL ?? "info" },
  pinoPretty({ colorize: true, sync: true }),
);
api.setLogger(logger);

const mnemonic = process.env.WALLET_MNEMONIC?.trim();
if (!mnemonic) throw new Error("WALLET_MNEMONIC missing in chain/.env");

const config = new PreprodConfig();
const seed = await api.mnemonicToSeed(mnemonic);
const walletContext = await api.initWalletWithSeed(seed, config);

let updates = 0;
walletContext.wallet.state().subscribe({
  next: (state) => {
    updates += 1;
    if (updates % 200 === 0 || updates === 1) {
      const s = state as unknown as {
        unshielded?: {
          progress?: unknown;
          balances?: Record<string, bigint>;
        };
      };
      logger.info(
        `update #${updates} | unshielded progress=${util.inspect(
          s.unshielded?.progress,
        )} | balances=${util.inspect(s.unshielded?.balances)}`,
      );
    }
  },
  error: (err) => {
    console.error("=== STATE STREAM ERROR (deep) ===");
    console.error(util.inspect(err, { depth: 10, colors: false }));
    process.exit(1);
  },
  complete: () => {
    console.error("state stream completed");
    process.exit(0);
  },
});

setTimeout(() => {
  console.log(`TIMEOUT after 120s, ${updates} updates, no stream error`);
  process.exit(0);
}, 120_000);

// VIGIL live relayer. Holds the synced Preprod wallet and the vault owner's
// private state, and submits real circuit calls when the public site asks
// for them. This is what turns the hosted demo's buttons into on-chain
// transactions: the browser talks to the Vercel proxy, the proxy talks to
// this process, and this process proves and submits like the CLI does.
//
//   npm run relayer -w vigil-chain
//
// Auth: every /act request must carry the shared token in x-vigil-token.
// Only owner-side circuits are exposed (pulse, deposit, attest). claim is
// terminal for the vault and stays operator-only; arm is one-shot and the
// vault is already armed.

import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import pino from "pino";
import pinoPretty from "pino-pretty";

import * as api from "./api";
import { PreprodConfig } from "./config";
import { createOwnerPrivateState } from "../../contract/src/witnesses";
import * as Vigil from "../../contract/src/managed/vigil/contract/index.js";

const chainDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const logger = pino(
  { level: process.env.DEBUG_LEVEL ?? "info" },
  pinoPretty({ colorize: true, sync: true }),
);
api.setLogger(logger);

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(Buffer.from(hex, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const randomBytes32 = (): Uint8Array => {
  const bytes = new Uint8Array(32);
  webcrypto.getRandomValues(bytes);
  return bytes;
};
const now = () => BigInt(Math.floor(Date.now() / 1000));

const PORT = Number(process.env.RELAYER_PORT ?? "6310");
const TOKEN = process.env.RELAYER_TOKEN?.trim();
if (!TOKEN || TOKEN.length < 24) {
  throw new Error(
    "RELAYER_TOKEN missing or too short (chain/.env). Generate 32+ random chars.",
  );
}

const deployment = JSON.parse(
  fs.readFileSync(path.join(chainDir, "deployment.json"), "utf8"),
);
const secretsPath = path.join(chainDir, "vault-secrets.json");
const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf8"));

// hard cap on visitor-supplied numbers; the circuit works in u64 space but
// the demo has no business near it
const MAX_AMOUNT = 1_000_000_000_000n;

const wireLedger = (l: Vigil.Ledger | null) =>
  l === null
    ? null
    : {
        state: Vigil.VaultState[l.state],
        ownerCommit: toHex(l.ownerCommit),
        heirCommit: toHex(l.heirCommit),
        balanceCommit: toHex(l.balanceCommit),
        lastPulse: l.lastPulse.toString(),
        vigilWindow: l.vigilWindow.toString(),
        pulses: l.pulses.toString(),
        attestedFloor: l.attestedFloor.toString(),
        legacyNotePresent: l.legacyNote.is_some,
        claimReceipt: toHex(l.claimReceipt),
      };

const parseAmount = (raw: unknown, label: string): bigint => {
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new Error(`${label} must be a number`);
  }
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) throw new Error(`${label} must be a whole number`);
  const v = BigInt(s);
  if (v < 1n || v > MAX_AMOUNT) {
    throw new Error(`${label} must be between 1 and ${MAX_AMOUNT}`);
  }
  return v;
};

// ---------- boot: wallet, providers, contract ----------

logger.info("Relayer booting: restoring wallet from snapshot...");
const config = new PreprodConfig();
const mnemonic = process.env.WALLET_MNEMONIC?.trim();
if (!mnemonic) throw new Error("WALLET_MNEMONIC missing in chain/.env");

const walletContext = await api.buildWalletAndWaitForFunds(
  config,
  mnemonic,
  path.join(chainDir, "wallet-snapshot.json"),
);
const providers = await api.configureProviders(walletContext, config);
const contract = await api.joinContract(
  providers,
  deployment.contractAddress,
  createOwnerPrivateState(
    fromHex(secrets.ownerSecretKey),
    BigInt(secrets.balance),
    fromHex(secrets.balanceSalt),
  ),
);
providers.privateStateProvider.setContractAddress(deployment.contractAddress);

let ready = true;
logger.info(
  `Relayer ready: vault ${deployment.contractAddress} on ${config.networkId}, port ${PORT}`,
);

// ---------- serial op queue ----------
// Proofs take ~40s each and the proof server handles one at a time, so ops
// run strictly in sequence. The cap keeps a burst of visitors from queueing
// an hour of work.

let queued = 0;
let chainTail: Promise<unknown> = Promise.resolve();
const MAX_QUEUE = 3;

type OpResult = {
  op: string;
  txId: string;
  blockHeight: number;
  ledger: ReturnType<typeof wireLedger>;
};

const runOp = async (body: Record<string, unknown>): Promise<OpResult> => {
  const op = String(body.op ?? "");
  let tx;
  switch (op) {
    case "pulse": {
      tx = await api.keepVigil(contract, now());
      break;
    }
    case "deposit": {
      const amount = parseAmount(body.amount, "amount");
      const newSalt = randomBytes32();
      tx = await api.deposit(contract, amount, newSalt);
      // the witness does not roll private state forward; persist the new
      // balance + salt or the next proof would open a stale commitment
      secrets.balance = (BigInt(secrets.balance) + amount).toString();
      secrets.balanceSalt = toHex(newSalt);
      fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2));
      await providers.privateStateProvider.set(
        api.VigilPrivateStateId,
        createOwnerPrivateState(
          fromHex(secrets.ownerSecretKey),
          BigInt(secrets.balance),
          fromHex(secrets.balanceSalt),
        ),
      );
      break;
    }
    case "attest": {
      const threshold = parseAmount(body.threshold, "threshold");
      tx = await api.proveFunded(contract, threshold);
      break;
    }
    default:
      throw new Error(`Unknown op '${op}'. Use: pulse | deposit | attest`);
  }
  const ledger = await api.getVigilLedgerState(
    providers,
    deployment.contractAddress,
  );
  return {
    op,
    txId: tx.txId,
    blockHeight: tx.blockHeight,
    ledger: wireLedger(ledger),
  };
};

const enqueue = (body: Record<string, unknown>): Promise<OpResult> => {
  if (queued >= MAX_QUEUE) {
    throw Object.assign(
      new Error(
        "The relayer is busy proving other visitors' transactions. Try again in a minute.",
      ),
      { statusCode: 429 },
    );
  }
  queued += 1;
  const result = chainTail.then(
    () => runOp(body),
    () => runOp(body),
  );
  chainTail = result.finally(() => {
    queued -= 1;
  });
  return result;
};

// ---------- http ----------

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 4096) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

const respond = (
  res: http.ServerResponse,
  status: number,
  payload: unknown,
) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      respond(res, 200, {
        ok: true,
        ready,
        queued,
        network: config.networkId,
        contractAddress: deployment.contractAddress,
      });
      return;
    }
    if (req.method === "POST" && req.url === "/act") {
      if (req.headers["x-vigil-token"] !== TOKEN) {
        respond(res, 401, { ok: false, error: "Bad token" });
        return;
      }
      if (!ready) {
        respond(res, 503, { ok: false, error: "Relayer still syncing" });
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        respond(res, 400, { ok: false, error: "Invalid JSON body" });
        return;
      }
      const result = await enqueue(body);
      respond(res, 200, { ok: true, ...result });
      return;
    }
    respond(res, 404, { ok: false, error: "Not found" });
  } catch (e) {
    const status =
      typeof (e as { statusCode?: number }).statusCode === "number"
        ? (e as { statusCode: number }).statusCode
        : 500;
    respond(res, status, {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

// proofs hold requests open for ~40-60s; give them room
server.requestTimeout = 240_000;
server.headersTimeout = 30_000;

server.listen(PORT, () => {
  logger.info(`Relayer listening on http://127.0.0.1:${PORT}`);
});

const shutdown = async (signal: string) => {
  ready = false;
  logger.info(`${signal} received; closing wallet...`);
  server.close();
  await api.closeWallet(walletContext);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// VIGIL live relayer. Holds the synced Preprod treasury wallet and submits
// real circuit calls when the public site asks for them. Two families of
// endpoints:
//
//   POST /vault/new   deploy + arm a FRESH vault contract for a visitor.
//                     Secrets are generated in the visitor's browser and
//                     sent here only to build the proofs; the treasury
//                     wallet sponsors the dust fees.
//   POST /vault/act   run one circuit (pulse / deposit / attest / claim)
//                     against any vault, with the caller supplying the
//                     private state. The relayer keeps nothing per user:
//                     the browser owns the secrets and rolls its own
//                     balance commitment forward after deposits.
//   POST /act         legacy ops against the canonical house vault whose
//                     secrets live in vault-secrets.json.
//   GET  /health      liveness + queue depth.
//
//   npm run relayer -w vigil-chain
//
// Auth: every POST must carry the shared token in x-vigil-token. Proofs
// take ~40s each and run strictly serially (one proof server).

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
import {
  createOwnerPrivateState,
  createHeirPrivateState,
  type VigilPrivateState,
} from "../../contract/src/witnesses";
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

// hard caps on visitor-supplied values; the circuit works in u64 space but
// the demo has no business near it
const MAX_AMOUNT = 1_000_000_000_000n;
const MIN_WINDOW = 60n; // one minute
const MAX_WINDOW = 2_592_000n; // thirty days
const MAX_NOTE = 300;
const HEX64 = /^[0-9a-f]{64}$/i;

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

const bad = (message: string) =>
  Object.assign(new Error(message), { statusCode: 400 });

const parseAmount = (raw: unknown, label: string): bigint => {
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw bad(`${label} must be a number`);
  }
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) throw bad(`${label} must be a whole number`);
  const v = BigInt(s);
  if (v < 1n || v > MAX_AMOUNT) {
    throw bad(`${label} must be between 1 and ${MAX_AMOUNT}`);
  }
  return v;
};

const parseHex32 = (raw: unknown, label: string): Uint8Array => {
  if (typeof raw !== "string" || !HEX64.test(raw)) {
    throw bad(`${label} must be 64 hex characters`);
  }
  return fromHex(raw);
};

// ---------- boot: wallet, providers, house contract ----------

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

const houseState = (): VigilPrivateState =>
  createOwnerPrivateState(
    fromHex(secrets.ownerSecretKey),
    BigInt(secrets.balance),
    fromHex(secrets.balanceSalt),
  );

// The private state store is scoped by contract address. House and visitor
// vaults share one provider, so every job pins the scope AND the state it
// needs before calling a circuit; the serial queue makes this safe.
const useVault = async (address: string, state: VigilPrivateState) => {
  providers.privateStateProvider.setContractAddress(address);
  await providers.privateStateProvider.set(api.VigilPrivateStateId, state);
};

const houseContract = await api.joinContract(
  providers,
  deployment.contractAddress,
  houseState(),
);

let ready = true;
logger.info(
  `Relayer ready: house vault ${deployment.contractAddress} on ${config.networkId}, port ${PORT}`,
);

// ---------- ops ----------

type OpResult = Record<string, unknown>;

const ledgerFor = async (address: string) =>
  wireLedger(await api.getVigilLedgerState(providers, address));

// deploy + arm a fresh vault for a visitor (two proofs, ~90s)
const runNewVault = async (body: Record<string, unknown>): Promise<OpResult> => {
  const ownerSecretKey = parseHex32(body.ownerSecretKey, "ownerSecretKey");
  const heirSecret = parseHex32(body.heirSecret, "heirSecret");
  const balanceSalt = parseHex32(body.balanceSalt, "balanceSalt");
  const balance = parseAmount(body.balance, "balance");
  const windowSeconds = parseAmount(body.window, "window");
  if (windowSeconds < MIN_WINDOW || windowSeconds > MAX_WINDOW) {
    throw bad(`window must be between ${MIN_WINDOW} and ${MAX_WINDOW} seconds`);
  }
  const note =
    typeof body.note === "string" && body.note.trim().length > 0
      ? body.note.slice(0, MAX_NOTE)
      : "the key to the estate";

  const ownerState = createOwnerPrivateState(
    ownerSecretKey,
    balance,
    balanceSalt,
  );
  const contract = await api.deploy(providers, ownerState);
  const pub = contract.deployTxData.public as unknown as {
    contractAddress: string;
    txId: string;
    blockHeight: number;
  };
  logger.info(`Visitor vault deployed at ${pub.contractAddress}`);

  const heirCommitment = Vigil.pureCircuits.heirPk(heirSecret);
  const armTx = await api.arm(
    contract,
    heirCommitment,
    windowSeconds,
    now(),
    note,
  );

  return {
    contractAddress: pub.contractAddress,
    deployTxId: pub.txId,
    deployBlock: pub.blockHeight,
    armTxId: armTx.txId,
    armBlock: armTx.blockHeight,
    ledger: await ledgerFor(pub.contractAddress),
  };
};

// one circuit call against a visitor's vault, private state supplied by
// the caller
const runUserAct = async (body: Record<string, unknown>): Promise<OpResult> => {
  const address = String(body.contractAddress ?? "");
  if (!HEX64.test(address)) throw bad("contractAddress must be 64 hex characters");
  const op = String(body.op ?? "");

  let state: VigilPrivateState;
  if (op === "claim") {
    state = createHeirPrivateState(parseHex32(body.heirSecret, "heirSecret"));
  } else {
    state = createOwnerPrivateState(
      parseHex32(body.ownerSecretKey, "ownerSecretKey"),
      parseAmount(body.balance, "balance"),
      parseHex32(body.balanceSalt, "balanceSalt"),
    );
  }

  await useVault(address, state);
  const contract = await api.joinContract(providers, address, state);

  let tx;
  let note: string | undefined;
  switch (op) {
    case "pulse":
      tx = await api.keepVigil(contract, now());
      break;
    case "deposit": {
      const amount = parseAmount(body.amount, "amount");
      const newSalt = parseHex32(body.newSalt, "newSalt");
      tx = await api.deposit(contract, amount, newSalt);
      break;
    }
    case "attest":
      tx = await api.proveFunded(contract, parseAmount(body.threshold, "threshold"));
      break;
    case "claim": {
      const res = await api.claim(contract);
      tx = res.tx;
      note = res.note;
      break;
    }
    default:
      throw bad(`Unknown op '${op}'. Use: pulse | deposit | attest | claim`);
  }

  return {
    op,
    txId: tx.txId,
    blockHeight: tx.blockHeight,
    ...(note !== undefined ? { note } : {}),
    ledger: await ledgerFor(address),
  };
};

// legacy ops against the canonical house vault
const runHouseAct = async (body: Record<string, unknown>): Promise<OpResult> => {
  const op = String(body.op ?? "");
  await useVault(deployment.contractAddress, houseState());
  let tx;
  switch (op) {
    case "pulse": {
      tx = await api.keepVigil(houseContract, now());
      break;
    }
    case "deposit": {
      const amount = parseAmount(body.amount, "amount");
      const newSalt = randomBytes32();
      tx = await api.deposit(houseContract, amount, newSalt);
      // the witness does not roll private state forward; persist the new
      // balance + salt or the next proof would open a stale commitment
      secrets.balance = (BigInt(secrets.balance) + amount).toString();
      secrets.balanceSalt = toHex(newSalt);
      fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2));
      await useVault(deployment.contractAddress, houseState());
      break;
    }
    case "attest": {
      tx = await api.proveFunded(houseContract, parseAmount(body.threshold, "threshold"));
      break;
    }
    default:
      throw bad(`Unknown op '${op}'. Use: pulse | deposit | attest`);
  }
  return {
    op,
    txId: tx.txId,
    blockHeight: tx.blockHeight,
    ledger: await ledgerFor(deployment.contractAddress),
  };
};

// ---------- serial op queue ----------
// One proof server, ~40s per proof (a new vault is two proofs), so ops run
// strictly in sequence. The cap keeps a burst of visitors from queueing an
// hour of work.

let queued = 0;
let chainTail: Promise<unknown> = Promise.resolve();
const MAX_QUEUE = 3;

const enqueue = (job: () => Promise<OpResult>): Promise<OpResult> => {
  if (queued >= MAX_QUEUE) {
    throw Object.assign(
      new Error(
        "The relayer is busy proving other visitors' transactions. Try again in a minute.",
      ),
      { statusCode: 429 },
    );
  }
  queued += 1;
  const result = chainTail.then(job, job);
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
      if (data.length > 8192) {
        reject(bad("Body too large"));
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
    if (req.method === "POST") {
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
      let result: OpResult;
      if (req.url === "/vault/new") {
        result = await enqueue(() => runNewVault(body));
      } else if (req.url === "/vault/act") {
        result = await enqueue(() => runUserAct(body));
      } else if (req.url === "/act") {
        result = await enqueue(() => runHouseAct(body));
      } else {
        respond(res, 404, { ok: false, error: "Not found" });
        return;
      }
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

// a new vault holds its request open for two proofs; give it room
server.requestTimeout = 300_000;
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

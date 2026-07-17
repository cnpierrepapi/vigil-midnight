// VIGIL on-chain demo driver. Runs one circuit call per invocation against
// the deployed Preprod contract, using the wallet + secrets produced by
// deploy.ts.
//
//   npm run vigil -w vigil-chain -- state
//   npm run vigil -w vigil-chain -- arm 90 "the key to the estate"
//   npm run vigil -w vigil-chain -- pulse
//   npm run vigil -w vigil-chain -- deposit 50000
//   npm run vigil -w vigil-chain -- attest 50000
//   npm run vigil -w vigil-chain -- claim

import "dotenv/config";
import fs from "node:fs";
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

const deployment = JSON.parse(
  fs.readFileSync(path.join(chainDir, "deployment.json"), "utf8"),
);
const secretsPath = path.join(chainDir, "vault-secrets.json");
const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf8"));

const cmd = process.argv[2];
const argA = process.argv[3];
const argB = process.argv[4];

const config = new PreprodConfig();
const mnemonic = process.env.WALLET_MNEMONIC?.trim();
if (!mnemonic) throw new Error("WALLET_MNEMONIC missing in chain/.env");

const ownerState = () =>
  createOwnerPrivateState(
    fromHex(secrets.ownerSecretKey),
    BigInt(secrets.balance),
    fromHex(secrets.balanceSalt),
  );
const heirState = () => createHeirPrivateState(fromHex(secrets.heirSecret));

const showLedger = (l: Vigil.Ledger | null) => {
  if (!l) {
    logger.info("No contract state found");
    return;
  }
  logger.info(`state: ${Vigil.VaultState[l.state]}`);
  logger.info(`ownerCommit:   ${toHex(l.ownerCommit)}`);
  logger.info(`heirCommit:    ${toHex(l.heirCommit)}`);
  logger.info(`balanceCommit: ${toHex(l.balanceCommit)}`);
  logger.info(
    `lastPulse: ${l.lastPulse}  vigilWindow: ${l.vigilWindow}  pulses: ${l.pulses}  attestedFloor: ${l.attestedFloor}`,
  );
  logger.info(`legacyNote present: ${l.legacyNote.is_some}`);
  logger.info(`claimReceipt: ${toHex(l.claimReceipt)}`);
};

const walletContext = await api.buildWalletAndWaitForFunds(config, mnemonic);
try {
  const providers = await api.configureProviders(walletContext, config);

  if (cmd === "state") {
    showLedger(
      await api.getVigilLedgerState(providers, deployment.contractAddress),
    );
  } else {
    const privateState = cmd === "claim" ? heirState() : ownerState();
    const contract = await api.joinContract(
      providers,
      deployment.contractAddress,
      privateState,
    );

    const now = () => BigInt(Math.floor(Date.now() / 1000));

    switch (cmd) {
      case "arm": {
        const windowSeconds = BigInt(argA ?? "90");
        const note = argB ?? "the key to the estate";
        const heirCommitment = Vigil.pureCircuits.heirPk(
          fromHex(secrets.heirSecret),
        );
        await api.arm(contract, heirCommitment, windowSeconds, now(), note);
        break;
      }
      case "pulse":
        await api.keepVigil(contract, now());
        break;
      case "deposit": {
        const amount = BigInt(argA ?? "50000");
        const newSalt = randomBytes32();
        await api.deposit(contract, amount, newSalt);
        // roll the local private state forward to match the new commitment
        secrets.balance = (BigInt(secrets.balance) + amount).toString();
        secrets.balanceSalt = toHex(newSalt);
        fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2));
        logger.info("Local balance + salt rolled forward in vault-secrets.json");
        break;
      }
      case "attest":
        await api.proveFunded(contract, BigInt(argA ?? "50000"));
        break;
      case "claim": {
        const { note } = await api.claim(contract);
        if (note !== undefined) logger.info(`Legacy note released: ${note}`);
        break;
      }
      default:
        throw new Error(
          `Unknown command '${cmd}'. Use: state | arm | pulse | deposit | attest | claim`,
        );
    }
    showLedger(
      await api.getVigilLedgerState(providers, deployment.contractAddress),
    );
  }
} finally {
  await api.closeWallet(walletContext);
}
process.exit(0);

// Non-interactive VIGIL deploy to Midnight Preprod.
//
//   npm run deploy -w vigil-chain
//
// Reads chain/.env for MIDNIGHT_STORAGE_PASSWORD and (optionally)
// WALLET_MNEMONIC. Generates a wallet if none is configured, prints the
// address to fund at the faucet, waits for tNIGHT, registers DUST, deploys
// the contract with real ZK proofs from the proof server, and writes
// deployment.json + vault-secrets.json (both gitignored).

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import * as bip39 from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english";
import pino from "pino";
import pinoPretty from "pino-pretty";

import * as api from "./api";
import { PreprodConfig } from "./config";
import { createOwnerPrivateState } from "../../contract/src/witnesses";

const chainDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const logger = pino(
  { level: process.env.DEBUG_LEVEL ?? "info" },
  pinoPretty({ colorize: true, sync: true }),
);
api.setLogger(logger);

const randomBytes32 = (): Uint8Array => {
  const bytes = new Uint8Array(32);
  webcrypto.getRandomValues(bytes);
  return bytes;
};

const toHex = (b: Uint8Array) =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

const config = new PreprodConfig();
logger.info(`Network: ${config.networkId}`);
logger.info(`Proof server: ${config.proofServer}`);

// 1. wallet mnemonic: env or fresh
let mnemonic = process.env.WALLET_MNEMONIC?.trim();
if (!mnemonic) {
  mnemonic = bip39.generateMnemonic(english, 256);
  logger.warn("No WALLET_MNEMONIC in chain/.env; generated a fresh one:");
  logger.warn(mnemonic);
  fs.appendFileSync(
    path.join(chainDir, ".env"),
    `\nWALLET_MNEMONIC="${mnemonic}"\n`,
  );
  logger.info("Saved to chain/.env for reuse.");
}

// 2. build wallet, wait for faucet funds, register dust
const walletContext = await api.buildWalletAndWaitForFunds(config, mnemonic);

try {
  // 3. providers
  const providers = await api.configureProviders(walletContext, config);

  // 4. owner private state for this vault
  const balance = BigInt(process.env.VAULT_BALANCE ?? "100000");
  const ownerSecretKey = randomBytes32();
  const balanceSalt = randomBytes32();
  const heirSecret = randomBytes32();
  const ownerState = createOwnerPrivateState(
    ownerSecretKey,
    balance,
    balanceSalt,
  );

  // 5. deploy (constructor takes no args; args key must be omitted)
  const contract = await api.deploy(providers, ownerState);
  const contractAddress = contract.deployTxData.public.contractAddress;

  fs.writeFileSync(
    path.join(chainDir, "deployment.json"),
    JSON.stringify(
      {
        network: config.networkId,
        contractAddress,
        deployTxId: (contract.deployTxData.public as any).txId,
        blockHeight: (contract.deployTxData.public as any).blockHeight,
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(chainDir, "vault-secrets.json"),
    JSON.stringify(
      {
        ownerSecretKey: toHex(ownerSecretKey),
        heirSecret: toHex(heirSecret),
        balanceSalt: toHex(balanceSalt),
        balance: balance.toString(),
      },
      null,
      2,
    ),
  );
  logger.info(`DEPLOYED. Contract address: ${contractAddress}`);
  logger.info("Wrote chain/deployment.json and chain/vault-secrets.json");
} finally {
  await api.closeWallet(walletContext);
}
process.exit(0);

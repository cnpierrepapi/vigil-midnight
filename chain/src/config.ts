import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export const contractConfig = {
  privateStateStoreName: "vigil-private-state",
  // compiled circuit artifacts (proving keys, verifying keys, ZKIR)
  zkConfigPath: path.resolve(
    currentDir,
    "..",
    "..",
    "contract",
    "src",
    "managed",
    "vigil",
  ),
};

export interface Config {
  readonly indexer: string;
  readonly indexerWS: string;
  readonly node: string;
  readonly proofServer: string;
  readonly networkId: string;
}

// endpoints verified against docs.midnight.network zk-loan tutorial (Jul 2026)
export class PreprodConfig implements Config {
  indexer = "https://indexer.preprod.midnight.network/api/v4/graphql";
  indexerWS = "wss://indexer.preprod.midnight.network/api/v4/graphql/ws";
  node = "wss://rpc.preprod.midnight.network";
  proofServer =
    process.env.PROOF_SERVER_URL ?? "http://127.0.0.1:6300";
  networkId = "preprod";
}

import { NextResponse } from "next/server";
import { WebSocket } from "ws";
import { decodeLedgerHex, type WireLedger } from "@/lib/vault-engine";

export const dynamic = "force-dynamic";

// The indexer exposes contract history only as a subscription: it streams
// every action for an address from genesis, then stays open for live
// updates. We drain the historical stream and close on idle.
const WS_URL =
  process.env.MIDNIGHT_INDEXER_WS_URL ??
  "wss://indexer.preprod.midnight.network/api/v4/graphql/ws";

const HISTORY_SUB = `subscription R($address: HexEncoded!) {
  contractActions(address: $address) {
    __typename
    ... on ContractDeploy {
      state
      transaction { hash block { height timestamp } }
    }
    ... on ContractCall {
      entryPoint
      state
      transaction { hash block { height timestamp } }
    }
    ... on ContractUpdate {
      state
      transaction { hash block { height timestamp } }
    }
  }
}`;

type RawAction = {
  __typename: "ContractDeploy" | "ContractCall" | "ContractUpdate";
  entryPoint?: string;
  state: string;
  transaction: {
    hash: string;
    block: { height: number; timestamp: number };
  };
};

export type VaultRecord = {
  kind: string; // "deploy" or the circuit entry point
  txHash: string;
  blockHeight: number;
  timestamp: number; // unix millis from the indexer
  ledger: WireLedger;
};

function collectHistory(address: string): Promise<RawAction[]> {
  return new Promise((resolve, reject) => {
    const actions: RawAction[] = [];
    const ws = new WebSocket(WS_URL, "graphql-transport-ws");
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let done = false;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(capTimer);
      try {
        ws.close();
      } catch {
        // already closed
      }
      if (err && actions.length === 0) reject(err);
      else resolve(actions);
    };

    // hard cap so a hung socket can never hold the serverless function
    const capTimer = setTimeout(() => finish(), 12_000);

    // history is drained when the stream goes quiet
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(), 2_500);
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "connection_init" }));
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          type: string;
          payload?: {
            data?: { contractActions?: RawAction };
            errors?: Array<{ message: string }>;
          };
        };
        if (msg.type === "connection_ack") {
          ws.send(
            JSON.stringify({
              id: "1",
              type: "subscribe",
              payload: { query: HISTORY_SUB, variables: { address } },
            }),
          );
          armIdle();
          return;
        }
        if (msg.type === "next" && msg.payload?.data?.contractActions) {
          actions.push(msg.payload.data.contractActions);
          armIdle();
        }
        if (msg.type === "error") {
          finish(
            new Error(
              msg.payload && Array.isArray(msg.payload)
                ? JSON.stringify(msg.payload)
                : "indexer subscription error",
            ),
          );
        }
        if (msg.type === "complete") finish();
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    });
    ws.on("error", (e) => finish(e instanceof Error ? e : new Error(String(e))));
    ws.on("close", () => finish());
  });
}

export async function GET() {
  const contractAddress = process.env.VIGIL_CONTRACT_ADDRESS ?? null;
  if (!contractAddress) {
    return NextResponse.json(
      { ok: false, error: "VIGIL_CONTRACT_ADDRESS is not configured", records: [] },
      { status: 200 },
    );
  }
  try {
    const raw = await collectHistory(contractAddress);
    const records: VaultRecord[] = [];
    for (const a of raw) {
      records.push({
        kind: a.__typename === "ContractCall" ? (a.entryPoint ?? "call") : "deploy",
        txHash: a.transaction.hash,
        blockHeight: a.transaction.block.height,
        timestamp: a.transaction.block.timestamp,
        ledger: await decodeLedgerHex(a.state),
      });
    }
    return NextResponse.json({
      ok: true,
      network: "preprod",
      contractAddress,
      records,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        records: [],
      },
      { status: 200 },
    );
  }
}

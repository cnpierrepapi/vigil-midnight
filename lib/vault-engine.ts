// Server-side vault engine. Runs the REAL compiled VIGIL circuits through
// @midnight-ntwrk/compact-runtime, exactly the way the test suite does.
//
// Statelessness: Vercel functions cannot hold chain state between requests,
// so the demo chain is event-sourced. The client keeps a journal of every
// successful circuit call; each request replays the journal from the
// constructor, then executes the new action. Every replay step runs the
// actual circuit with its original timestamp, so the ledger state returned
// is always derived from real circuit execution, never faked.
//
// Module loading: the contract runtime wraps a WASM module whose classes
// break if two copies load (instanceof checks fail across instances), so
// BOTH the runtime and the compiled contract are loaded with webpackIgnore
// dynamic imports. Node's own ESM loader resolves everything from disk and
// its module cache guarantees a single WASM instance. Types come from
// erased type-only imports; no runtime value crosses the bundler boundary.
//
// Demo topology caveat (also shown in the UI): witnesses travel to this
// server. In production the proof server runs on the user's own machine.

import { pathToFileURL } from "node:url";
import path from "node:path";

type ContractModule = typeof import("../contract/src/managed/vigil/contract/index.js");
type Runtime = typeof import("@midnight-ntwrk/compact-runtime");
type Ledger = import("../contract/src/managed/vigil/contract/index.js").Ledger;

// Each party's DApp instance holds only the secrets it should hold; fields
// a role does not possess stay zeroed (same shape the test suite uses).
type VigilPrivateState = {
  readonly ownerSecretKey: Uint8Array;
  readonly heirSecret: Uint8Array;
  readonly balance: bigint;
  readonly balanceSalt: Uint8Array;
};

const witnesses = {
  ownerSecretKey: ({ privateState }: { privateState: VigilPrivateState }): [VigilPrivateState, Uint8Array] =>
    [privateState, privateState.ownerSecretKey],
  heirSecret: ({ privateState }: { privateState: VigilPrivateState }): [VigilPrivateState, Uint8Array] =>
    [privateState, privateState.heirSecret],
  vaultBalance: ({ privateState }: { privateState: VigilPrivateState }): [VigilPrivateState, bigint] =>
    [privateState, privateState.balance],
  balanceSalt: ({ privateState }: { privateState: VigilPrivateState }): [VigilPrivateState, Uint8Array] =>
    [privateState, privateState.balanceSalt],
};

const COIN_PUBLIC_KEY =
  "0000000000000000000000000000000000000000000000000000000000000000";

// ---------- native module loading (bypasses the bundler entirely) ----------

type Loaded = {
  rt: Runtime;
  mod: ContractModule;
  contract: import("../contract/src/managed/vigil/contract/index.js").Contract<VigilPrivateState>;
};

let loaded: Promise<Loaded> | null = null;

function load(): Promise<Loaded> {
  loaded ??= (async () => {
    const contractUrl = pathToFileURL(
      path.join(
        process.cwd(),
        "contract",
        "src",
        "managed",
        "vigil",
        "contract",
        "index.js",
      ),
    ).href;
    const mod = (await import(
      /* webpackIgnore: true */ contractUrl
    )) as ContractModule;
    // a native (webpackIgnore) bare-specifier import resolves from disk to
    // the same root node_modules copy the contract module itself loads, so
    // Node's ESM cache returns one shared WASM instance to both of us
    const rt = (await import(
      /* webpackIgnore: true */ "@midnight-ntwrk/compact-runtime"
    )) as Runtime;
    const contract = new mod.Contract<VigilPrivateState>(witnesses);
    return { rt, mod, contract };
  })();
  return loaded;
}

// ---------- wire formats (JSON-safe) ----------

export type WireSecrets = {
  ownerSecretKey: string; // 32-byte hex
  heirSecret: string; // 32-byte hex
  balance: string; // decimal string
  balanceSalt: string; // 32-byte hex
};

export type JournalEntry = {
  circuit: "arm" | "keepVigil" | "deposit" | "proveFunded" | "claim";
  time: number; // unix seconds when executed
  args: {
    heirCommitment?: string; // hex (arm)
    window?: string; // decimal seconds (arm)
    now?: string; // decimal unix seconds (arm, keepVigil)
    note?: string; // plaintext note (arm)
    amount?: string; // decimal (deposit)
    newSalt?: string; // hex (deposit)
    threshold?: string; // decimal (proveFunded)
  };
  privateState: WireSecrets;
};

export type VaultAction =
  | { kind: "arm"; window: number; note: string; secrets: WireSecrets }
  | { kind: "keepVigil"; secrets: WireSecrets }
  | { kind: "deposit"; amount: string; newSalt: string; secrets: WireSecrets }
  | { kind: "proveFunded"; threshold: string; secrets: WireSecrets }
  | { kind: "claim"; heirSecret: string }
  | { kind: "inspect" };

export type WireLedger = {
  state: "UNARMED" | "ARMED" | "CLAIMED";
  ownerCommit: string;
  heirCommit: string;
  balanceCommit: string;
  lastPulse: string;
  vigilWindow: string;
  pulses: string;
  attestedFloor: string;
  legacyNotePresent: boolean;
  claimReceipt: string;
};

export type VaultResponse = {
  ok: boolean;
  error?: string;
  journal: JournalEntry[];
  ledger: WireLedger | null;
  result?: string; // the legacy note, on a successful claim
  serverTime: number;
};

// ---------- codecs ----------

const HEX_RE = /^[0-9a-fA-F]{64}$/;

function fromHex(hex: string): Uint8Array {
  if (!HEX_RE.test(hex)) throw new Error("Expected 32-byte hex value");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function decodeSecrets(w: WireSecrets): VigilPrivateState {
  return {
    ownerSecretKey: fromHex(w.ownerSecretKey),
    heirSecret: fromHex(w.heirSecret),
    balance: BigInt(w.balance),
    balanceSalt: fromHex(w.balanceSalt),
  };
}

function serializeLedger(mod: ContractModule, l: Ledger): WireLedger {
  const name =
    l.state === mod.VaultState.ARMED
      ? "ARMED"
      : l.state === mod.VaultState.CLAIMED
        ? "CLAIMED"
        : "UNARMED";
  return {
    state: name,
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
}

// ---------- replay ----------

const ZERO_SECRETS: WireSecrets = {
  ownerSecretKey: "0".repeat(64),
  heirSecret: "0".repeat(64),
  balance: "0",
  balanceSalt: "0".repeat(64),
};

type ChainPoint = {
  state: unknown;
  lastResult?: unknown;
};

function callCircuit(
  { contract }: Loaded,
  entry: JournalEntry,
  ctx: any,
) {
  const a = entry.args;
  switch (entry.circuit) {
    case "arm":
      return contract.impureCircuits.arm(
        ctx,
        fromHex(a.heirCommitment!),
        BigInt(a.window!),
        BigInt(a.now!),
        a.note ?? "",
      );
    case "keepVigil":
      return contract.impureCircuits.keepVigil(ctx, BigInt(a.now!));
    case "deposit":
      return contract.impureCircuits.deposit(
        ctx,
        BigInt(a.amount!),
        fromHex(a.newSalt!),
      );
    case "proveFunded":
      return contract.impureCircuits.proveFunded(ctx, BigInt(a.threshold!));
    case "claim":
      return contract.impureCircuits.claim(ctx);
  }
}

function replay(env: Loaded, journal: JournalEntry[]): ChainPoint {
  const { rt, contract } = env;
  const addr = rt.sampleContractAddress();
  const initial = contract.initialState(
    rt.createConstructorContext(decodeSecrets(ZERO_SECRETS), COIN_PUBLIC_KEY),
  );
  let zswap: unknown = initial.currentZswapLocalState;
  // normalize ContractState -> query-context state (what ledger() reads),
  // same as the test harness, which never reads ContractState directly
  const ctx0 = rt.createCircuitContext(
    addr,
    initial.currentZswapLocalState,
    initial.currentContractState,
    decodeSecrets(ZERO_SECRETS),
    undefined,
    undefined,
    0,
  );
  let state: unknown = ctx0.currentQueryContext.state;
  let lastResult: unknown;

  for (const entry of journal) {
    const ctx = rt.createCircuitContext(
      addr,
      zswap as any,
      state as any,
      decodeSecrets(entry.privateState),
      undefined,
      undefined,
      entry.time,
    );
    const r = callCircuit(env, entry, ctx)!;
    zswap = r.context.currentZswapLocalState;
    state = r.context.currentQueryContext.state;
    lastResult = r.result;
  }
  return { state, lastResult };
}

function ledgerOf(env: Loaded, point: ChainPoint): WireLedger {
  return serializeLedger(env.mod, env.mod.ledger(point.state as any));
}

// ---------- live testnet read (indexer -> real deserialized ledger) ----------

// Same query the midnight-js indexer provider runs; a plain fetch keeps
// Apollo and its dependency tail out of the serverless bundle.
const INDEXER_URL =
  process.env.MIDNIGHT_INDEXER_URL ??
  "https://indexer.preprod.midnight.network/api/v4/graphql";

const CONTRACT_STATE_QUERY = `query CONTRACT_STATE_QUERY($address: HexEncoded!, $offset: ContractActionOffset) {
  contractAction(address: $address, offset: $offset) { state }
}`;

export type ChainLedgerResponse = {
  ok: boolean;
  error?: string;
  network: "preprod";
  contractAddress: string | null;
  ledger: WireLedger | null;
  fetchedAt: number;
};

function hexToBytesVar(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : "0" + hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// Decodes one hex-encoded on-chain contract state into the wire ledger.
// Used by the records route, which fetches the state after every action.
export async function decodeLedgerHex(stateHex: string): Promise<WireLedger> {
  const env = await load();
  const contractState = env.rt.ContractState.deserialize(hexToBytesVar(stateHex));
  return serializeLedger(env.mod, env.mod.ledger(contractState.data));
}

export async function fetchChainLedger(
  addressOverride?: string,
): Promise<ChainLedgerResponse> {
  const contractAddress =
    addressOverride ?? process.env.VIGIL_CONTRACT_ADDRESS ?? null;
  const fetchedAt = Math.floor(Date.now() / 1000);
  const fail = (error: string): ChainLedgerResponse => ({
    ok: false,
    error,
    network: "preprod",
    contractAddress,
    ledger: null,
    fetchedAt,
  });

  if (!contractAddress) return fail("Not deployed yet: VIGIL_CONTRACT_ADDRESS is not configured");
  try {
    const env = await load();
    const res = await fetch(INDEXER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: CONTRACT_STATE_QUERY,
        variables: { address: contractAddress, offset: null },
      }),
      cache: "no-store",
    });
    if (!res.ok) return fail(`Indexer HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: { contractAction?: { state?: string } | null };
      errors?: Array<{ message: string }>;
    };
    if (body.errors?.length) return fail(body.errors[0].message);
    const stateHex = body.data?.contractAction?.state;
    if (!stateHex) return fail("Contract not found on the preprod indexer");
    const contractState = env.rt.ContractState.deserialize(hexToBytesVar(stateHex));
    const ledger = serializeLedger(env.mod, env.mod.ledger(contractState.data));
    return { ok: true, network: "preprod", contractAddress, ledger, fetchedAt };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ---------- public API ----------

export async function handleAction(
  journal: JournalEntry[],
  action: VaultAction,
): Promise<VaultResponse> {
  const env = await load();
  const now = Math.floor(Date.now() / 1000);

  if (action.kind === "inspect") {
    const point = replay(env, journal);
    return {
      ok: true,
      journal,
      ledger: ledgerOf(env, point),
      serverTime: now,
    };
  }

  let entry: JournalEntry;
  switch (action.kind) {
    case "arm":
      // arm takes the heir commitment as a public argument and never calls
      // the heirSecret witness, so the journal keeps that secret zeroed:
      // the owner's private state holds owner secrets only.
      entry = {
        circuit: "arm",
        time: now,
        args: {
          heirCommitment: toHex(
            env.mod.pureCircuits.heirPk(fromHex(action.secrets.heirSecret)),
          ),
          window: String(action.window),
          now: String(now),
          note: action.note,
        },
        privateState: { ...action.secrets, heirSecret: "0".repeat(64) },
      };
      break;
    case "keepVigil":
      entry = {
        circuit: "keepVigil",
        time: now,
        args: { now: String(now) },
        privateState: action.secrets,
      };
      break;
    case "deposit":
      entry = {
        circuit: "deposit",
        time: now,
        args: { amount: action.amount, newSalt: action.newSalt },
        privateState: action.secrets,
      };
      break;
    case "proveFunded":
      entry = {
        circuit: "proveFunded",
        time: now,
        args: { threshold: action.threshold },
        privateState: action.secrets,
      };
      break;
    case "claim":
      entry = {
        circuit: "claim",
        time: now,
        args: {},
        privateState: { ...ZERO_SECRETS, heirSecret: action.heirSecret },
      };
      break;
  }

  const next = [...journal, entry];
  try {
    const point = replay(env, next);
    return {
      ok: true,
      journal: next,
      ledger: ledgerOf(env, point),
      result:
        action.kind === "claim" && typeof point.lastResult === "string"
          ? point.lastResult
          : undefined,
      serverTime: now,
    };
  } catch (e) {
    // the failed action is NOT appended; return the untouched chain state
    let ledgerState: WireLedger | null = null;
    try {
      ledgerState = ledgerOf(env, replay(env, journal));
    } catch {
      ledgerState = null;
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      journal,
      ledger: ledgerState,
      serverTime: now,
    };
  }
}

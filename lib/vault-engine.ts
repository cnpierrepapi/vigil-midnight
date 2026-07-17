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
// Demo topology caveat (also shown in the UI): witnesses travel to this
// server. In production the proof server runs on the user's own machine.

import {
  Contract,
  ledger,
  pureCircuits,
  VaultState,
  type Ledger,
} from "../contract/src/managed/vigil/contract/index.js";
import {
  witnesses,
  type VigilPrivateState,
} from "../contract/src/witnesses";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";

const COIN_PUBLIC_KEY =
  "0000000000000000000000000000000000000000000000000000000000000000";

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

function stateName(s: VaultState): WireLedger["state"] {
  if (s === VaultState.ARMED) return "ARMED";
  if (s === VaultState.CLAIMED) return "CLAIMED";
  return "UNARMED";
}

function serializeLedger(l: Ledger): WireLedger {
  return {
    state: stateName(l.state),
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

const contract = new Contract<VigilPrivateState>(witnesses);

const ZERO_SECRETS: WireSecrets = {
  ownerSecretKey: "0".repeat(64),
  heirSecret: "0".repeat(64),
  balance: "0",
  balanceSalt: "0".repeat(64),
};

type ChainPoint = {
  addr: ReturnType<typeof sampleContractAddress>;
  zswap: unknown;
  state: unknown;
  lastResult?: unknown;
};

function callCircuit(entry: JournalEntry, ctx: any) {
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

function replay(journal: JournalEntry[]): ChainPoint {
  const addr = sampleContractAddress();
  const initial = contract.initialState(
    createConstructorContext(decodeSecrets(ZERO_SECRETS), COIN_PUBLIC_KEY),
  );
  let zswap: unknown = initial.currentZswapLocalState;
  let state: unknown = initial.currentContractState;
  let lastResult: unknown;

  for (const entry of journal) {
    const ctx = createCircuitContext(
      addr,
      zswap as any,
      state as any,
      decodeSecrets(entry.privateState),
      undefined,
      undefined,
      entry.time,
    );
    const r = callCircuit(entry, ctx)!;
    zswap = r.context.currentZswapLocalState;
    state = r.context.currentQueryContext.state;
    lastResult = r.result;
  }
  return { addr, zswap, state, lastResult };
}

function ledgerOf(point: ChainPoint): WireLedger {
  return serializeLedger(ledger(point.state as any));
}

// ---------- public API ----------

export function heirCommitmentOf(heirSecretHex: string): string {
  return toHex(pureCircuits.heirPk(fromHex(heirSecretHex)));
}

export function handleAction(
  journal: JournalEntry[],
  action: VaultAction,
): VaultResponse {
  const now = Math.floor(Date.now() / 1000);

  if (action.kind === "inspect") {
    const point = replay(journal);
    return {
      ok: true,
      journal,
      ledger: ledgerOf(point),
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
          heirCommitment: heirCommitmentOf(action.secrets.heirSecret),
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
    const point = replay(next);
    return {
      ok: true,
      journal: next,
      ledger: ledgerOf(point),
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
      ledgerState = ledgerOf(replay(journal));
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

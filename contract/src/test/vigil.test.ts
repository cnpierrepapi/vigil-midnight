import { describe, it, expect, beforeEach } from "vitest";
import {
  Contract,
  ledger,
  pureCircuits,
  VaultState,
} from "../managed/vigil/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
  type CircuitContext,
} from "@midnight-ntwrk/compact-runtime";
import {
  createOwnerPrivateState,
  createHeirPrivateState,
  witnesses,
  type VigilPrivateState,
} from "../witnesses";

const COIN_PUBLIC_KEY =
  "0000000000000000000000000000000000000000000000000000000000000000";

const ownerKey = new Uint8Array(32);
ownerKey[0] = 0x01;
const heirSecret = new Uint8Array(32);
heirSecret[0] = 0x02;
const impostorKey = new Uint8Array(32);
impostorKey[0] = 0x03;

const salt = new Uint8Array(32);
salt[0] = 0xaa;
const salt2 = new Uint8Array(32);
salt2[0] = 0xbb;

const BALANCE = 100_000n;
const T0 = 1_000_000;
const WINDOW = 600n;

const ownerState = () => createOwnerPrivateState(ownerKey, BALANCE, salt);
const heirState = () => createHeirPrivateState(heirSecret);

const ownerContract = new Contract<VigilPrivateState>(witnesses);
const heirContract = new Contract<VigilPrivateState>(witnesses);

const heirCommitment = pureCircuits.heirPk(heirSecret);

// The trailing `time` argument of createCircuitContext simulates kernel
// block time locally: it is what blockTimeGte/blockTimeGt check against,
// so the whole deadline mechanism is testable without a proof server.
function freshContext(
  privateState: VigilPrivateState,
  time: number,
): { addr: ReturnType<typeof sampleContractAddress>; ctx: CircuitContext<VigilPrivateState> } {
  const addr = sampleContractAddress();
  const initial = ownerContract.initialState(
    createConstructorContext(privateState, COIN_PUBLIC_KEY),
  );
  const ctx = createCircuitContext(
    addr,
    initial.currentZswapLocalState,
    initial.currentContractState,
    privateState,
    undefined,
    undefined,
    time,
  );
  return { addr, ctx };
}

// Advance simulated block time and/or swap the acting party by rebuilding
// the context from the previous call's resulting on-chain state.
function withTimeAndState(
  addr: ReturnType<typeof sampleContractAddress>,
  prev: CircuitContext<VigilPrivateState>,
  privateState: VigilPrivateState,
  time: number,
): CircuitContext<VigilPrivateState> {
  return createCircuitContext(
    addr,
    prev.currentZswapLocalState,
    prev.currentQueryContext.state,
    privateState,
    undefined,
    undefined,
    time,
  );
}

describe("VIGIL", () => {
  let addr: ReturnType<typeof sampleContractAddress>;
  let armedCtx: CircuitContext<VigilPrivateState>;

  beforeEach(() => {
    const fresh = freshContext(ownerState(), T0);
    addr = fresh.addr;
    const r = ownerContract.impureCircuits.arm(
      fresh.ctx,
      heirCommitment,
      WINDOW,
      BigInt(T0),
      "the key to the estate",
    );
    armedCtx = r.context;
  });

  describe("arm", () => {
    it("arms the vault", () => {
      const state = ledger(armedCtx.currentQueryContext.state);
      expect(state.state).toBe(VaultState.ARMED);
      expect(state.pulses).toBe(1n);
      expect(state.lastPulse).toBe(BigInt(T0));
      expect(state.vigilWindow).toBe(WINDOW);
    });

    it("rejects double arming", () => {
      expect(() =>
        ownerContract.impureCircuits.arm(
          armedCtx,
          heirCommitment,
          WINDOW,
          BigInt(T0),
          "again",
        ),
      ).toThrow("Vault is already armed");
    });

    it("rejects a post-dated arm timestamp", () => {
      const fresh = freshContext(ownerState(), T0);
      expect(() =>
        ownerContract.impureCircuits.arm(
          fresh.ctx,
          heirCommitment,
          WINDOW,
          BigInt(T0 + 999_999),
          "from the future",
        ),
      ).toThrow("Pulse is timestamped in the future");
    });
  });

  describe("keepVigil", () => {
    it("owner keeps vigil (heartbeat)", () => {
      const ctx = withTimeAndState(addr, armedCtx, ownerState(), T0 + 100);
      const r = ownerContract.impureCircuits.keepVigil(ctx, BigInt(T0 + 100));
      const state = ledger(r.context.currentQueryContext.state);
      expect(state.pulses).toBe(2n);
      expect(state.lastPulse).toBe(BigInt(T0 + 100));
    });

    it("rejects a heartbeat before the vault is armed", () => {
      const fresh = freshContext(ownerState(), T0);
      expect(() =>
        ownerContract.impureCircuits.keepVigil(fresh.ctx, BigInt(T0)),
      ).toThrow("Vault is not armed");
    });

    it("rejects a heartbeat from an impostor", () => {
      const impostor = createOwnerPrivateState(impostorKey, BALANCE, salt);
      const ctx = withTimeAndState(addr, armedCtx, impostor, T0 + 100);
      expect(() =>
        ownerContract.impureCircuits.keepVigil(ctx, BigInt(T0 + 100)),
      ).toThrow("Not the vault owner");
    });

    it("rejects a post-dated heartbeat", () => {
      const ctx = withTimeAndState(addr, armedCtx, ownerState(), T0 + 100);
      expect(() =>
        ownerContract.impureCircuits.keepVigil(ctx, BigInt(T0 + 999_999)),
      ).toThrow("Pulse is timestamped in the future");
    });

    it("rejects a pulse older than the last one", () => {
      const beat = ownerContract.impureCircuits.keepVigil(
        withTimeAndState(addr, armedCtx, ownerState(), T0 + 200),
        BigInt(T0 + 200),
      );
      const ctx = withTimeAndState(addr, beat.context, ownerState(), T0 + 300);
      expect(() =>
        ownerContract.impureCircuits.keepVigil(ctx, BigInt(T0 + 100)),
      ).toThrow("Pulse is older than the last one");
    });
  });

  describe("proveFunded", () => {
    it("proves the vault is funded above a threshold without revealing balance", () => {
      const ctx = withTimeAndState(addr, armedCtx, ownerState(), T0 + 100);
      const r = ownerContract.impureCircuits.proveFunded(ctx, 50_000n);
      const state = ledger(r.context.currentQueryContext.state);
      expect(state.attestedFloor).toBe(50_000n);
    });

    it("attests a floor exactly equal to the balance (boundary)", () => {
      const ctx = withTimeAndState(addr, armedCtx, ownerState(), T0 + 100);
      const r = ownerContract.impureCircuits.proveFunded(ctx, BALANCE);
      const state = ledger(r.context.currentQueryContext.state);
      expect(state.attestedFloor).toBe(BALANCE);
    });

    it("rejects a funding attestation above the real balance", () => {
      const ctx = withTimeAndState(addr, armedCtx, ownerState(), T0 + 100);
      expect(() =>
        ownerContract.impureCircuits.proveFunded(ctx, BALANCE + 1n),
      ).toThrow("Vault balance is below the attested floor");
    });

    it("rejects an attestation from an impostor", () => {
      const impostor = createOwnerPrivateState(impostorKey, BALANCE, salt);
      const ctx = withTimeAndState(addr, armedCtx, impostor, T0 + 100);
      expect(() =>
        ownerContract.impureCircuits.proveFunded(ctx, 1n),
      ).toThrow("Not the vault owner");
    });
  });

  describe("deposit", () => {
    it("rolls the balance commitment forward", () => {
      const before = ledger(armedCtx.currentQueryContext.state).balanceCommit;
      const ctx = withTimeAndState(addr, armedCtx, ownerState(), T0 + 100);
      const r = ownerContract.impureCircuits.deposit(ctx, 50_000n, salt2);
      const after = ledger(r.context.currentQueryContext.state).balanceCommit;
      expect(after).not.toEqual(before);

      // the owner can now attest to the higher floor with the new salt
      const updated = createOwnerPrivateState(ownerKey, BALANCE + 50_000n, salt2);
      const ctx2 = withTimeAndState(addr, r.context, updated, T0 + 200);
      const r2 = ownerContract.impureCircuits.proveFunded(ctx2, 140_000n);
      expect(ledger(r2.context.currentQueryContext.state).attestedFloor).toBe(
        140_000n,
      );
    });

    it("rejects a deposit from an impostor", () => {
      const impostor = createOwnerPrivateState(impostorKey, BALANCE, salt);
      const ctx = withTimeAndState(addr, armedCtx, impostor, T0 + 100);
      expect(() =>
        ownerContract.impureCircuits.deposit(ctx, 1n, salt2),
      ).toThrow("Not the vault owner");
    });

    it("rejects a deposit whose private balance does not match the commitment", () => {
      const wrongBalance = createOwnerPrivateState(ownerKey, BALANCE + 1n, salt);
      const ctx = withTimeAndState(addr, armedCtx, wrongBalance, T0 + 100);
      expect(() =>
        ownerContract.impureCircuits.deposit(ctx, 1n, salt2),
      ).toThrow("Private balance does not match the on-chain commitment");
    });
  });

  describe("claim", () => {
    it("rejects a claim while the vigil holds", () => {
      const ctx = withTimeAndState(addr, armedCtx, heirState(), T0 + 100);
      expect(() => heirContract.impureCircuits.claim(ctx)).toThrow(
        "The vigil holds; the owner is still with us",
      );
    });

    it("rejects a claim at the exact lapse second (strictly-greater boundary)", () => {
      const ctx = withTimeAndState(
        addr,
        armedCtx,
        heirState(),
        T0 + Number(WINDOW),
      );
      expect(() => heirContract.impureCircuits.claim(ctx)).toThrow(
        "The vigil holds; the owner is still with us",
      );
    });

    it("lets the heir claim after the vigil lapses", () => {
      const lapsed = T0 + Number(WINDOW) + 1;
      const ctx = withTimeAndState(addr, armedCtx, heirState(), lapsed);
      const r = heirContract.impureCircuits.claim(ctx);
      expect(r.result).toBe("the key to the estate");
      const state = ledger(r.context.currentQueryContext.state);
      expect(state.state).toBe(VaultState.CLAIMED);
    });

    it("rejects a claim from an impostor even after the lapse", () => {
      const lapsed = T0 + Number(WINDOW) + 1;
      const impostor = createHeirPrivateState(impostorKey);
      const ctx = withTimeAndState(addr, armedCtx, impostor, lapsed);
      expect(() => heirContract.impureCircuits.claim(ctx)).toThrow(
        "Not the designated heir",
      );
    });

    it("rejects a second claim on an already-claimed vault", () => {
      const lapsed = T0 + Number(WINDOW) + 1;
      const first = heirContract.impureCircuits.claim(
        withTimeAndState(addr, armedCtx, heirState(), lapsed),
      );
      const ctx = withTimeAndState(addr, first.context, heirState(), lapsed + 1);
      expect(() => heirContract.impureCircuits.claim(ctx)).toThrow(
        "Vault is not armed",
      );
    });

    it("a heartbeat resets the clock: claim that would have passed now fails", () => {
      const beatCtx = withTimeAndState(addr, armedCtx, ownerState(), T0 + 500);
      const beat = ownerContract.impureCircuits.keepVigil(beatCtx, BigInt(T0 + 500));

      const wouldHaveLapsed = T0 + Number(WINDOW) + 1;
      const ctx = withTimeAndState(addr, beat.context, heirState(), wouldHaveLapsed);
      expect(() => heirContract.impureCircuits.claim(ctx)).toThrow(
        "The vigil holds; the owner is still with us",
      );
    });
  });
});

import { Ledger } from "./managed/vigil/contract/index.js";
import { WitnessContext } from "@midnight-ntwrk/compact-runtime";

// Each party runs its own DApp instance holding only the secrets it should
// hold. Fields the current role does not possess stay zeroed and are never
// sent to circuits that role is allowed to call.
export type VigilPrivateState = {
  readonly ownerSecretKey: Uint8Array;
  readonly heirSecret: Uint8Array;
  readonly balance: bigint;
  readonly balanceSalt: Uint8Array;
};

export const createOwnerPrivateState = (
  ownerSecretKey: Uint8Array,
  balance: bigint,
  balanceSalt: Uint8Array,
): VigilPrivateState => ({
  ownerSecretKey,
  heirSecret: new Uint8Array(32),
  balance,
  balanceSalt,
});

export const createHeirPrivateState = (
  heirSecret: Uint8Array,
): VigilPrivateState => ({
  ownerSecretKey: new Uint8Array(32),
  heirSecret,
  balance: 0n,
  balanceSalt: new Uint8Array(32),
});

export const witnesses = {
  ownerSecretKey: ({
    privateState,
  }: WitnessContext<Ledger, VigilPrivateState>): [
    VigilPrivateState,
    Uint8Array,
  ] => [privateState, privateState.ownerSecretKey],

  heirSecret: ({
    privateState,
  }: WitnessContext<Ledger, VigilPrivateState>): [
    VigilPrivateState,
    Uint8Array,
  ] => [privateState, privateState.heirSecret],

  vaultBalance: ({
    privateState,
  }: WitnessContext<Ledger, VigilPrivateState>): [
    VigilPrivateState,
    bigint,
  ] => [privateState, privateState.balance],

  balanceSalt: ({
    privateState,
  }: WitnessContext<Ledger, VigilPrivateState>): [
    VigilPrivateState,
    Uint8Array,
  ] => [privateState, privateState.balanceSalt],
};

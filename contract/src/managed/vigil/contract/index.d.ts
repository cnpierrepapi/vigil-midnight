import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export enum VaultState { UNARMED = 0, ARMED = 1, CLAIMED = 2 }

export type Witnesses<PS> = {
  ownerSecretKey(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  heirSecret(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  vaultBalance(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, bigint];
  balanceSalt(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  arm(context: __compactRuntime.CircuitContext<PS>,
      heirCommitment_0: Uint8Array,
      window_0: bigint,
      now_0: bigint,
      note_0: string): __compactRuntime.CircuitResults<PS, []>;
  keepVigil(context: __compactRuntime.CircuitContext<PS>, now_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  deposit(context: __compactRuntime.CircuitContext<PS>,
          amount_0: bigint,
          newSalt_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  proveFunded(context: __compactRuntime.CircuitContext<PS>, threshold_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  claim(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
}

export type ProvableCircuits<PS> = {
  arm(context: __compactRuntime.CircuitContext<PS>,
      heirCommitment_0: Uint8Array,
      window_0: bigint,
      now_0: bigint,
      note_0: string): __compactRuntime.CircuitResults<PS, []>;
  keepVigil(context: __compactRuntime.CircuitContext<PS>, now_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  deposit(context: __compactRuntime.CircuitContext<PS>,
          amount_0: bigint,
          newSalt_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  proveFunded(context: __compactRuntime.CircuitContext<PS>, threshold_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  claim(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
}

export type PureCircuits = {
  ownerPk(sk_0: Uint8Array): Uint8Array;
  heirPk(secret_0: Uint8Array): Uint8Array;
  balanceCommitment(amount_0: bigint, salt_0: Uint8Array): Uint8Array;
}

export type Circuits<PS> = {
  ownerPk(context: __compactRuntime.CircuitContext<PS>, sk_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  heirPk(context: __compactRuntime.CircuitContext<PS>, secret_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  balanceCommitment(context: __compactRuntime.CircuitContext<PS>,
                    amount_0: bigint,
                    salt_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  arm(context: __compactRuntime.CircuitContext<PS>,
      heirCommitment_0: Uint8Array,
      window_0: bigint,
      now_0: bigint,
      note_0: string): __compactRuntime.CircuitResults<PS, []>;
  keepVigil(context: __compactRuntime.CircuitContext<PS>, now_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  deposit(context: __compactRuntime.CircuitContext<PS>,
          amount_0: bigint,
          newSalt_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  proveFunded(context: __compactRuntime.CircuitContext<PS>, threshold_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  claim(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
}

export type Ledger = {
  readonly state: VaultState;
  readonly ownerCommit: Uint8Array;
  readonly heirCommit: Uint8Array;
  readonly balanceCommit: Uint8Array;
  readonly lastPulse: bigint;
  readonly vigilWindow: bigint;
  readonly pulses: bigint;
  readonly attestedFloor: bigint;
  readonly legacyNote: { is_some: boolean, value: string };
  readonly claimReceipt: Uint8Array;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;

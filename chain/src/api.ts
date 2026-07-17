// VIGIL chain API: wallet building, provider wiring, deploy/join, and
// circuit-call wrappers for the five VIGIL circuits on Midnight Preprod.
// Structure follows the official zk-loan CLI tutorial (Midnight JS 4.1.x,
// wallet-sdk 1.1.0 barrel).

import "dotenv/config";
import { type ContractAddress } from "@midnight-ntwrk/midnight-js-protocol/compact-runtime";
import * as ledger from "@midnight-ntwrk/midnight-js-protocol/ledger";
import { CompiledContract } from "@midnight-ntwrk/midnight-js-protocol/compact-js";
import {
  deployContract,
  findDeployedContract,
  type DeployedContract,
  type FoundContract,
} from "@midnight-ntwrk/midnight-js-contracts";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import {
  type FinalizedTxData,
  type MidnightProvider,
  type MidnightProviders,
  type WalletProvider,
  type UnboundTransaction,
} from "@midnight-ntwrk/midnight-js-types";
import { assertIsContractAddress } from "@midnight-ntwrk/midnight-js-utils";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import {
  HDWallet,
  Roles,
  WalletFacade,
  ShieldedWallet,
  DustWallet,
  UnshieldedWallet,
  createKeystore,
  InMemoryTransactionHistoryStorage,
  WalletEntrySchema,
  PublicKey as UnshieldedPublicKey,
  type UnshieldedKeystore,
} from "@midnight-ntwrk/wallet-sdk";
import * as bip39 from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english";
import { type Logger } from "pino";
import * as Rx from "rxjs";
import { WebSocket } from "ws";
import { Buffer } from "buffer";

import * as Vigil from "../../contract/src/managed/vigil/contract/index.js";
import {
  witnesses,
  type VigilPrivateState,
} from "../../contract/src/witnesses";
import { type Config, contractConfig } from "./config";

let logger: Logger;

// The SDK's GraphQL subscriptions expect a global WebSocket constructor
// @ts-expect-error: Needed to enable WebSocket usage through Apollo
globalThis.WebSocket = WebSocket;

// ---------- types ----------

export type VigilCircuits =
  | "arm"
  | "keepVigil"
  | "deposit"
  | "proveFunded"
  | "claim";

export const VigilPrivateStateId = "vigilPrivateState";

export type VigilProviders = MidnightProviders<
  VigilCircuits,
  typeof VigilPrivateStateId,
  VigilPrivateState
>;

export type VigilContract = Vigil.Contract<VigilPrivateState>;

export type DeployedVigilContract =
  | DeployedContract<VigilContract>
  | FoundContract<VigilContract>;

// ---------- compiled contract ----------

export const vigilCompiledContract = CompiledContract.make<VigilContract>(
  "Vigil",
  Vigil.Contract,
).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(contractConfig.zkConfigPath),
);

// ---------- ledger state ----------

export const getVigilLedgerState = async (
  providers: VigilProviders,
  contractAddress: ContractAddress,
): Promise<Vigil.Ledger | null> => {
  assertIsContractAddress(contractAddress);
  const state = await providers.publicDataProvider
    .queryContractState(contractAddress)
    .then((contractState) =>
      contractState != null ? Vigil.ledger(contractState.data) : null,
    );
  return state;
};

// ---------- deploy / join ----------

export const deploy = async (
  providers: VigilProviders,
  privateState: VigilPrivateState,
): Promise<DeployedVigilContract> => {
  logger.info("Deploying VIGIL contract to Preprod...");
  const contract = await deployContract(providers as any, {
    compiledContract: vigilCompiledContract,
    privateStateId: VigilPrivateStateId,
    initialPrivateState: privateState,
  });
  logger.info(
    `Deployed contract at address: ${contract.deployTxData.public.contractAddress}`,
  );
  return contract as any;
};

export const joinContract = async (
  providers: VigilProviders,
  contractAddress: string,
  privateState: VigilPrivateState,
): Promise<DeployedVigilContract> => {
  const contract = await findDeployedContract(providers as any, {
    contractAddress,
    compiledContract: vigilCompiledContract,
    privateStateId: VigilPrivateStateId,
    initialPrivateState: privateState,
  });
  logger.info(
    `Joined contract at address: ${contract.deployTxData.public.contractAddress}`,
  );
  return contract as any;
};

// ---------- circuit wrappers ----------

const finalize = (label: string) => (tx: { public: FinalizedTxData }) => {
  logger.info(
    `${label}: tx ${tx.public.txId} in block ${tx.public.blockHeight}`,
  );
  return tx.public;
};

export const arm = async (
  contract: DeployedVigilContract,
  heirCommitment: Uint8Array,
  windowSeconds: bigint,
  now: bigint,
  note: string,
): Promise<FinalizedTxData> => {
  logger.info("Arming the vault (proof generation takes about a minute)...");
  const tx = await contract.callTx.arm(heirCommitment, windowSeconds, now, note);
  return finalize("arm")(tx);
};

export const keepVigil = async (
  contract: DeployedVigilContract,
  now: bigint,
): Promise<FinalizedTxData> => {
  logger.info("Keeping vigil (ZK heartbeat)...");
  const tx = await contract.callTx.keepVigil(now);
  return finalize("keepVigil")(tx);
};

export const deposit = async (
  contract: DeployedVigilContract,
  amount: bigint,
  newSalt: Uint8Array,
): Promise<FinalizedTxData> => {
  logger.info("Rolling the balance commitment forward...");
  const tx = await contract.callTx.deposit(amount, newSalt);
  return finalize("deposit")(tx);
};

export const proveFunded = async (
  contract: DeployedVigilContract,
  threshold: bigint,
): Promise<FinalizedTxData> => {
  logger.info("Attesting funding floor...");
  const tx = await contract.callTx.proveFunded(threshold);
  return finalize("proveFunded")(tx);
};

export const claim = async (
  contract: DeployedVigilContract,
): Promise<{ tx: FinalizedTxData; note?: string }> => {
  logger.info("Claiming the estate...");
  const tx = await contract.callTx.claim();
  // circuit return-value location in the CircuitCallTxData shape varies by
  // SDK version; probe the known candidates rather than assume
  const anyTx = tx as any;
  const note =
    anyTx?.private?.result ?? anyTx?.result ?? anyTx?.public?.result;
  return { tx: finalize("claim")(tx), note };
};

// ---------- wallet ----------

export interface WalletContext {
  wallet: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

export const createWalletAndMidnightProvider = async (
  walletContext: WalletContext,
): Promise<WalletProvider & MidnightProvider> => {
  await Rx.firstValueFrom(
    walletContext.wallet.state().pipe(Rx.filter((s) => s.isSynced)),
  );
  return {
    getCoinPublicKey(): ledger.CoinPublicKey {
      return walletContext.shieldedSecretKeys.coinPublicKey;
    },
    getEncryptionPublicKey(): ledger.EncPublicKey {
      return walletContext.shieldedSecretKeys.encryptionPublicKey;
    },
    async balanceTx(
      tx: UnboundTransaction,
      ttl?: Date,
    ): Promise<ledger.FinalizedTransaction> {
      const txTtl = ttl ?? new Date(Date.now() + 30 * 60 * 1000);
      const recipe = await walletContext.wallet.balanceUnboundTransaction(
        tx,
        {
          shieldedSecretKeys: walletContext.shieldedSecretKeys,
          dustSecretKey: walletContext.dustSecretKey,
        },
        { ttl: txTtl },
      );
      return await walletContext.wallet.finalizeRecipe(recipe);
    },
    async submitTx(
      tx: ledger.FinalizedTransaction,
    ): Promise<ledger.TransactionId> {
      return await walletContext.wallet.submitTransaction(tx);
    },
  };
};

// isSynced = shielded && dust && unshielded streams each report
// isConnected + appliedIndex caught up to highestRelevantWalletIndex.
// Log each stream so a dead subscription is visible instead of an
// endless "Synced: false".
const describeProgress = (p: unknown): string => {
  if (!p || typeof p !== "object") return "n/a";
  const d = p as {
    isConnected?: boolean;
    appliedIndex?: bigint;
    highestRelevantWalletIndex?: bigint;
    // unshielded progress uses transaction ids instead of event indices
    appliedId?: bigint;
    highestTransactionId?: bigint;
  };
  const applied = d.appliedIndex ?? d.appliedId;
  const highest = d.highestRelevantWalletIndex ?? d.highestTransactionId;
  return `conn=${d.isConnected} applied=${applied}/${highest}`;
};

export const waitForSync = (wallet: WalletFacade) =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(5_000),
      Rx.tap((state) => {
        const s = state as unknown as {
          shielded?: { state?: { progress?: unknown } };
          dust?: { state?: { progress?: unknown } };
          unshielded?: { progress?: unknown };
        };
        logger.info(
          `Waiting for wallet sync. Synced: ${state.isSynced} | shielded ${describeProgress(
            s.shielded?.state?.progress,
          )} | dust ${describeProgress(
            s.dust?.state?.progress,
          )} | unshielded ${describeProgress(s.unshielded?.progress)}`,
        );
      }),
      Rx.filter((state) => state.isSynced),
    ),
  );

export const waitForFunds = (wallet: WalletFacade) =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(10_000),
      Rx.tap((state) => {
        const unshielded =
          state.unshielded?.balances[ledger.nativeToken().raw] ?? 0n;
        const shielded =
          state.shielded?.balances[ledger.nativeToken().raw] ?? 0n;
        logger.info(
          `Waiting for funds. Synced: ${state.isSynced}, Unshielded: ${unshielded}, Shielded: ${shielded}`,
        );
      }),
      Rx.filter((state) => state.isSynced),
      Rx.map(
        (s) =>
          (s.unshielded?.balances[ledger.nativeToken().raw] ?? 0n) +
          (s.shielded?.balances[ledger.nativeToken().raw] ?? 0n),
      ),
      Rx.filter((balance) => balance > 0n),
    ),
  );

export const displayWalletBalances = async (
  wallet: WalletFacade,
): Promise<{ unshielded: bigint; shielded: bigint; total: bigint; dust: bigint }> => {
  const state = await Rx.firstValueFrom(wallet.state());
  const unshielded =
    state.unshielded?.balances[ledger.nativeToken().raw] ?? 0n;
  const shielded =
    state.shielded?.balances[ledger.nativeToken().raw] ?? 0n;
  const total = unshielded + shielded;
  const dust = state.dust?.balance(new Date()) ?? 0n;
  logger.info(`Unshielded NIGHT: ${unshielded}, Shielded: ${shielded}, DUST (fees): ${dust}`);
  return { unshielded, shielded, total, dust };
};

export const registerNightForDust = async (
  walletContext: WalletContext,
): Promise<boolean> => {
  const state = await Rx.firstValueFrom(
    walletContext.wallet.state().pipe(Rx.filter((s) => s.isSynced)),
  );
  const unregisteredNightUtxos =
    state.unshielded?.availableCoins.filter(
      (coin) => coin.meta.registeredForDustGeneration === false,
    ) ?? [];
  if (unregisteredNightUtxos.length === 0) {
    logger.info("No unregistered NIGHT UTXOs; checking dust balance");
    const dustBalance = state.dust?.balance(new Date()) ?? 0n;
    logger.info(`Current dust balance: ${dustBalance}`);
    return dustBalance > 0n;
  }
  logger.info(
    `Registering ${unregisteredNightUtxos.length} NIGHT UTXOs for dust generation...`,
  );
  try {
    const recipe =
      await walletContext.wallet.registerNightUtxosForDustGeneration(
        unregisteredNightUtxos,
        walletContext.unshieldedKeystore.getPublicKey(),
        (payload) => walletContext.unshieldedKeystore.signData(payload),
      );
    const finalizedTx = await walletContext.wallet.finalizeRecipe(recipe);
    const txId = await walletContext.wallet.submitTransaction(finalizedTx);
    logger.info(`Dust registration submitted: ${txId}. Waiting for dust...`);
    await Rx.firstValueFrom(
      walletContext.wallet.state().pipe(
        Rx.throttleTime(5_000),
        Rx.tap((s) => {
          logger.info(`Dust balance: ${s.dust?.balance(new Date()) ?? 0n}`);
        }),
        Rx.filter((s) => (s.dust?.balance(new Date()) ?? 0n) > 0n),
      ),
    );
    logger.info("Dust registration complete");
    return true;
  } catch (e) {
    logger.error(`Failed to register NIGHT for dust: ${e}`);
    return false;
  }
};

export const mnemonicToSeed = async (mnemonic: string): Promise<Buffer> => {
  const words = mnemonic.trim().split(/\s+/);
  if (!bip39.validateMnemonic(words.join(" "), english)) {
    throw new Error("Invalid mnemonic phrase");
  }
  const seed = await bip39.mnemonicToSeed(words.join(" "));
  return Buffer.from(seed);
};

export const initWalletWithSeed = async (
  seed: Buffer,
  config: Config,
): Promise<WalletContext> => {
  const hdWallet = HDWallet.fromSeed(seed);
  if (hdWallet.type !== "seedOk") {
    throw new Error("Failed to initialize HDWallet");
  }
  const derivationResult = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derivationResult.type !== "keysDerived") {
    throw new Error("Failed to derive keys");
  }
  hdWallet.hdWallet.clear();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(
    derivationResult.keys[Roles.Zswap],
  );
  const dustSecretKey = ledger.DustSecretKey.fromSeed(
    derivationResult.keys[Roles.Dust],
  );
  const unshieldedKeystore = createKeystore(
    derivationResult.keys[Roles.NightExternal],
    config.networkId as any,
  );

  const relayURL = new URL(config.node.replace(/^http/, "ws"));
  // First sync scans the full chain history (~1.3M indexer events on
  // preprod). Default batching (size 10, 4ms spacing) throttles the dust
  // stream to ~50 events/s, which is hours; larger batches with no
  // spacing bring it to a usable rate.
  const batchUpdates = { size: 1000, timeout: 25, spacing: 0 };
  const shieldedConfig = {
    networkId: config.networkId,
    indexerClientConnection: {
      indexerHttpUrl: config.indexer,
      indexerWsUrl: config.indexerWS,
    },
    batchUpdates,
    provingServerUrl: new URL(config.proofServer),
    relayURL,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema),
  };
  const unshieldedConfig = {
    networkId: config.networkId,
    indexerClientConnection: {
      indexerHttpUrl: config.indexer,
      indexerWsUrl: config.indexerWS,
    },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema),
  };
  const dustConfig = {
    networkId: config.networkId,
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000n,
      feeBlocksMargin: 5,
    },
    batchUpdates,
    indexerClientConnection: {
      indexerHttpUrl: config.indexer,
      indexerWsUrl: config.indexerWS,
    },
    provingServerUrl: new URL(config.proofServer),
    relayURL,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema),
  };

  const unifiedConfig = { ...shieldedConfig, ...unshieldedConfig, ...dustConfig };
  const facade = await WalletFacade.init({
    configuration: unifiedConfig,
    shielded: () =>
      ShieldedWallet(shieldedConfig).startWithSecretKeys(shieldedSecretKeys),
    unshielded: () =>
      UnshieldedWallet(unshieldedConfig).startWithPublicKey(
        UnshieldedPublicKey.fromKeyStore(unshieldedKeystore),
      ),
    dust: () =>
      DustWallet(dustConfig).startWithSecretKey(
        dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
      ),
  });
  await facade.start(shieldedSecretKeys, dustSecretKey);

  return { wallet: facade, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
};

export const buildWalletAndWaitForFunds = async (
  config: Config,
  mnemonic: string,
): Promise<WalletContext> => {
  logger.info("Building wallet from mnemonic...");
  const seed = await mnemonicToSeed(mnemonic);
  const walletContext = await initWalletWithSeed(seed, config);
  logger.info(
    `Your wallet address: ${walletContext.unshieldedKeystore.getBech32Address().asString()}`,
  );
  logger.info("Waiting for wallet to sync...");
  await waitForSync(walletContext.wallet);
  const { total } = await displayWalletBalances(walletContext.wallet);
  if (total === 0n) {
    logger.info(
      "Wallet is empty. Fund it with tNIGHT at https://faucet.preprod.midnight.network then wait here.",
    );
    await waitForFunds(walletContext.wallet);
    await displayWalletBalances(walletContext.wallet);
  }
  await registerNightForDust(walletContext);
  return walletContext;
};

// ---------- providers ----------

export const configureProviders = async (
  walletContext: WalletContext,
  config: Config,
): Promise<VigilProviders> => {
  setNetworkId(config.networkId);
  const walletAndMidnightProvider =
    await createWalletAndMidnightProvider(walletContext);
  const storagePassword = process.env.MIDNIGHT_STORAGE_PASSWORD;
  if (!storagePassword) {
    throw new Error(
      "MIDNIGHT_STORAGE_PASSWORD is not set (chain/.env). Required to encrypt private state on disk.",
    );
  }
  const zkConfigProvider = new NodeZkConfigProvider<VigilCircuits>(
    contractConfig.zkConfigPath,
  );
  return {
    privateStateProvider: levelPrivateStateProvider<
      typeof VigilPrivateStateId
    >({
      privateStateStoreName: contractConfig.privateStateStoreName,
      privateStoragePasswordProvider: () => storagePassword,
      accountId: walletContext.unshieldedKeystore
        .getBech32Address()
        .asString(),
    }),
    publicDataProvider: indexerPublicDataProvider(
      config.indexer,
      config.indexerWS,
    ),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(config.proofServer, zkConfigProvider),
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };
};

export function setLogger(_logger: Logger) {
  logger = _logger;
}

export const closeWallet = async (
  walletContext: WalletContext,
): Promise<void> => {
  try {
    await walletContext.wallet.stop();
  } catch (e) {
    logger.error(`Error closing wallet: ${e}`);
  }
};

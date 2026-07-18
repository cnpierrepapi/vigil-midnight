"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

// ---------- wire types (mirror lib/vault-engine.ts + relayer) ----------

type WireLedger = {
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

type ChainLedgerResponse = {
  ok: boolean;
  error?: string;
  network: "preprod";
  contractAddress: string | null;
  ledger: WireLedger | null;
  fetchedAt: number;
};

// Everything needed to drive one vault. Secrets are generated in this
// browser and stored only here; the relayer sees them per request to build
// proofs, and the chain only ever sees commitments.
type MyVault = {
  contractAddress: string;
  ownerSecretKey: string;
  heirSecret: string;
  balance: string;
  balanceSalt: string;
  deployTxId?: string;
  armTxId?: string;
};

// ---------- helpers ----------

const ZERO64 = "0".repeat(64);
const STORE_VAULT = "vigil.myVault.v1";

function randomHex32(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function shortHash(hex: string): string {
  if (!hex) return "";
  return `0x${hex.slice(0, 10)}…${hex.slice(-6)}`;
}

function chainHash(hex: string): string {
  if (!hex || hex === ZERO64) return "0x00…00 (all zeros on chain)";
  return `0x${hex.slice(0, 10)}…${hex.slice(-6)}`;
}

function fmtSeconds(total: number): string {
  const s = Math.max(0, total);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

// ---------- Lace wallet (Midnight DApp connector) ----------
// Shapes follow the official leaderboard browser-dapp tutorial: wallets
// register under window.midnight keyed by name, expose apiVersion (4.x),
// connect(networkId) resolves to an API with getShieldedAddresses() and
// getConfiguration().

type ConnectorInitialAPI = {
  apiVersion: string;
  connect: (networkId: string) => Promise<ConnectorConnectedAPI>;
};

type ConnectorConnectedAPI = {
  getShieldedAddresses: () => Promise<readonly string[]>;
  getConfiguration: () => Promise<{ proverServerUri?: string }>;
};

type WalletConn =
  | { status: "detecting" }
  | { status: "no-wallet" }
  | { status: "ready"; name: string }
  | { status: "connecting" }
  | {
      status: "connected";
      name: string;
      address: string;
      network: string;
      proverServerUri?: string;
    }
  | { status: "error"; message: string };

function findConnectorWallet(): { name: string; api: ConnectorInitialAPI } | null {
  const midnight = (window as unknown as { midnight?: Record<string, unknown> })
    .midnight;
  if (!midnight) return null;
  for (const [name, candidate] of Object.entries(midnight)) {
    if (
      candidate &&
      typeof candidate === "object" &&
      "apiVersion" in candidate &&
      typeof (candidate as ConnectorInitialAPI).connect === "function" &&
      String((candidate as ConnectorInitialAPI).apiVersion).startsWith("4")
    ) {
      return { name, api: candidate as ConnectorInitialAPI };
    }
  }
  return null;
}

// ---------- page ----------

export default function VaultPage() {
  const [tab, setTab] = useState<"owner" | "heir">("owner");
  const [vault, setVault] = useState<MyVault | null>(null);
  const [led, setLed] = useState<WireLedger | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [lastTx, setLastTx] = useState<{ label: string; txId: string; blockHeight: number } | null>(null);
  const [claimedNote, setClaimedNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const clockOffset = useRef(0);
  const hydrated = useRef(false);

  // form state
  const [windowSec, setWindowSec] = useState("600");
  const [initialBalance, setInitialBalance] = useState("100000");
  const [note, setNote] = useState("the key to the estate");
  const [depositAmount, setDepositAmount] = useState("250");
  const [threshold, setThreshold] = useState("50000");
  const [heirInput, setHeirInput] = useState("");

  // Lace wallet connection (Midnight DApp connector)
  const [wallet, setWallet] = useState<WalletConn>({ status: "detecting" });

  useEffect(() => {
    let tries = 0;
    const timer = setInterval(() => {
      const found = findConnectorWallet();
      if (found) {
        clearInterval(timer);
        setWallet({ status: "ready", name: found.name });
      } else if (++tries >= 30) {
        clearInterval(timer);
        setWallet({ status: "no-wallet" });
      }
    }, 100);
    return () => clearInterval(timer);
  }, []);

  const connectWallet = useCallback(async () => {
    const found = findConnectorWallet();
    if (!found) {
      setWallet({ status: "no-wallet" });
      return;
    }
    setWallet({ status: "connecting" });
    try {
      // VIGIL's vaults live on preprod, but current Lace builds only speak
      // the preview testnet for Midnight; fall back to the wallet's own
      // network so the connection succeeds, and label it honestly.
      let network = "preprod";
      let api: ConnectorConnectedAPI;
      try {
        api = await found.api.connect("preprod");
      } catch (first) {
        const msg = first instanceof Error ? first.message : String(first);
        if (!/network id mismatch/i.test(msg)) throw first;
        network = "preview";
        api = await found.api.connect("preview");
      }
      const [address] = await api.getShieldedAddresses();
      const config = await api.getConfiguration();
      setWallet({
        status: "connected",
        name: found.name,
        address: address ?? "(no address)",
        network,
        proverServerUri: config.proverServerUri,
      });
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Wallet declined the connection";
      let message = raw;
      // "Remote API ... was shutdown" is the Lace extension's background
      // worker going idle mid-handshake, not a DApp-side failure
      if (/shutdown|no longer be used/i.test(raw)) {
        message =
          "Lace's background process was asleep. Open the Lace extension, unlock it, then press Connect again.";
      }
      setWallet({ status: "error", message });
    }
  }, []);

  // ---------- chain state polling ----------

  const refreshChain = useCallback(async (address: string) => {
    try {
      const res = await fetch(`/api/chain?address=${address}`, {
        cache: "no-store",
      });
      const data = (await res.json()) as ChainLedgerResponse;
      if (data.ok && data.ledger) {
        setLed(data.ledger);
        clockOffset.current = data.fetchedAt - Math.floor(Date.now() / 1000);
        setNow(data.fetchedAt);
      }
    } catch {
      // transient network failure; the next poll retries
    }
  }, []);

  useEffect(() => {
    if (!vault) return;
    refreshChain(vault.contractAddress);
    const t = setInterval(() => refreshChain(vault.contractAddress), 15_000);
    return () => clearInterval(t);
  }, [vault, refreshChain]);

  // 1s clock for the countdown
  useEffect(() => {
    const t = setInterval(
      () => setNow(Math.floor(Date.now() / 1000) + clockOffset.current),
      1000,
    );
    return () => clearInterval(t);
  }, []);

  // hydrate from localStorage once
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    try {
      const raw = localStorage.getItem(STORE_VAULT);
      if (raw) {
        const v = JSON.parse(raw) as MyVault;
        setVault(v);
        setHeirInput(v.heirSecret);
      }
    } catch {
      // corrupted local state; start fresh
    }
  }, []);

  const saveVault = (v: MyVault) => {
    setVault(v);
    localStorage.setItem(STORE_VAULT, JSON.stringify(v));
  };

  const forgetVault = () => {
    localStorage.removeItem(STORE_VAULT);
    setVault(null);
    setLed(null);
    setClaimedNote(null);
    setFlash(null);
    setLastTx(null);
    setHeirInput("");
  };

  // ---------- relayer calls ----------

  const relay = useCallback(
    async (
      op: string,
      payload: Record<string, unknown>,
      label: string,
    ): Promise<Record<string, unknown> | null> => {
      setBusy(op);
      setFlash(null);
      setLastTx(null);
      try {
        const res = await fetch("/api/live", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op, ...payload }),
        });
        const data = (await res.json()) as Record<string, unknown>;
        if (data.ok) {
          if (data.ledger) setLed(data.ledger as WireLedger);
          if (typeof data.txId === "string") {
            setLastTx({
              label,
              txId: data.txId,
              blockHeight: Number(data.blockHeight),
            });
          }
          return data;
        }
        setFlash({
          kind: "err",
          text:
            typeof data.error === "string"
              ? data.error
              : "The relayer refused the request.",
        });
        return null;
      } catch (e) {
        setFlash({
          kind: "err",
          text: e instanceof Error ? e.message : String(e),
        });
        return null;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  // ---------- actions (every one settles on Midnight Preprod) ----------

  const createVault = async () => {
    const fresh = {
      ownerSecretKey: randomHex32(),
      heirSecret: randomHex32(),
      balanceSalt: randomHex32(),
    };
    const data = await relay(
      "new",
      {
        window: windowSec.trim(),
        note,
        balance: initialBalance.trim(),
        ...fresh,
      },
      "arm",
    );
    if (data && typeof data.contractAddress === "string") {
      saveVault({
        contractAddress: data.contractAddress,
        ownerSecretKey: fresh.ownerSecretKey,
        heirSecret: fresh.heirSecret,
        balance: initialBalance.trim(),
        balanceSalt: fresh.balanceSalt,
        deployTxId: typeof data.deployTxId === "string" ? data.deployTxId : undefined,
        armTxId: typeof data.armTxId === "string" ? data.armTxId : undefined,
      });
      setHeirInput(fresh.heirSecret);
      setLastTx({
        label: "arm",
        txId: String(data.armTxId ?? ""),
        blockHeight: Number(data.armBlock ?? 0),
      });
      setFlash({
        kind: "ok",
        text: "Your vault is live on Midnight Preprod. The vigil begins.",
      });
    }
  };

  const ownerPayload = () =>
    vault
      ? {
          contractAddress: vault.contractAddress,
          ownerSecretKey: vault.ownerSecretKey,
          balance: vault.balance,
          balanceSalt: vault.balanceSalt,
        }
      : {};

  const pulse = async () => {
    if (!vault) return;
    const r = await relay("pulse", ownerPayload(), "keepVigil");
    if (r) setFlash({ kind: "ok", text: "Pulse settled on chain. The vigil holds." });
  };

  const deposit = async () => {
    if (!vault) return;
    const newSalt = randomHex32();
    const r = await relay(
      "deposit",
      { ...ownerPayload(), amount: depositAmount.trim(), newSalt },
      "deposit",
    );
    if (r) {
      // roll the local private state forward to match the new commitment
      saveVault({
        ...vault,
        balance: (
          BigInt(vault.balance) + BigInt(depositAmount.trim())
        ).toString(),
        balanceSalt: newSalt,
      });
      setFlash({
        kind: "ok",
        text: "Deposit sealed on chain. The commitment rolled forward; the amount stays private.",
      });
    }
  };

  const attest = async () => {
    if (!vault) return;
    const r = await relay(
      "attest",
      { ...ownerPayload(), threshold: threshold.trim() },
      "proveFunded",
    );
    if (r)
      setFlash({
        kind: "ok",
        text: `Attested on chain: the vault holds at least ${Number(threshold).toLocaleString()}. The balance itself stays private.`,
      });
  };

  const claim = async () => {
    if (!vault) return;
    const r = await relay(
      "claim",
      { contractAddress: vault.contractAddress, heirSecret: heirInput.trim() },
      "claim",
    );
    if (r) {
      if (typeof r.note === "string") setClaimedNote(r.note);
      setFlash({ kind: "ok", text: "The claim proof passed. The estate is yours." });
    }
  };

  // ---------- derived ----------

  const armed = led?.state === "ARMED";
  const claimed = led?.state === "CLAIMED";
  const lapseAt = led ? Number(led.lastPulse) + Number(led.vigilWindow) : 0;
  const remaining = lapseAt - now;
  const lapsed = armed && remaining < 0;

  const busyText: Record<string, string> = {
    new: "Deploying your vault contract, then sealing it with arm. Two real ZK proofs, about 90 seconds. The chain does not hurry.",
    pulse: "Proving you hold the owner key. About 40 seconds.",
    deposit: "Rolling the balance commitment forward on chain. About 40 seconds.",
    attest: "Proving the balance clears the floor without revealing it. About 40 seconds.",
    claim: "Proving the vigil lapsed and you hold the heir secret. About 40 seconds.",
  };

  return (
    <main className="shell">
      <header className="masthead">
        <div className="candle">
          <div className={lapsed || claimed ? "flame out" : "flame"} />
          <div className="wax" />
        </div>
        <h1>
          <Link href="/">VIGIL</Link>
        </h1>
        <p className="tagline">
          A zero-knowledge dead man&apos;s switch on Midnight.
          <br />
          While the owner keeps their vigil, the vault is sealed.
        </p>
      </header>

      <div className="demo-banner">
        <p>
          <strong>Everything here is on chain.</strong> Your vault is a real
          contract deployed to Midnight Preprod; every button generates a
          real ZK proof (about 40 seconds) and settles in a block. Secrets
          are generated in this browser and sent only to the VIGIL relayer
          to build proofs; fees are sponsored by the VIGIL treasury wallet,
          so you never need a faucet. The chain itself sees commitments and
          nothing else.
        </p>
        <div className="cta-row">
          <a
            href="https://github.com/cnpierrepapi/vigil-midnight#readme"
            className="cta ghost small"
            target="_blank"
            rel="noopener noreferrer"
          >
            README
          </a>
          <Link href="/" className="cta ghost small">
            Run it yourself on Docker
          </Link>
          <Link href="/records" className="cta ghost small">
            House vault record
          </Link>
        </div>
      </div>

      <div className="wallet-strip">
        {wallet.status === "detecting" && (
          <span className="wallet-note">Looking for a Midnight wallet…</span>
        )}
        {wallet.status === "no-wallet" && (
          <span className="wallet-note">
            No Midnight wallet detected.{" "}
            <a
              href="https://chromewebstore.google.com/detail/lace/gafhhkghbfjjkeiendhlofajokpaflmk"
              target="_blank"
              rel="noopener noreferrer"
            >
              Install Lace
            </a>{" "}
            to connect.
          </span>
        )}
        {(wallet.status === "ready" || wallet.status === "error") && (
          <>
            <button className="cta ghost small" onClick={connectWallet}>
              Connect Lace
            </button>
            {wallet.status === "error" && (
              <span className="wallet-note">{wallet.message}</span>
            )}
          </>
        )}
        {wallet.status === "connecting" && (
          <span className="wallet-note">Waiting for wallet approval…</span>
        )}
        {wallet.status === "connected" && (
          <span className="wallet-note">
            <strong>{wallet.name}</strong> connected on {wallet.network}:{" "}
            <code className="inline" title={wallet.address}>
              {wallet.address.length > 24
                ? `${wallet.address.slice(0, 14)}…${wallet.address.slice(-8)}`
                : wallet.address}
            </code>
            {wallet.network === "preview"
              ? " · note: your vault runs on preprod, so this wallet observes but does not sign here"
              : ""}
          </span>
        )}
      </div>

      <div className="tabs">
        <button
          className={tab === "owner" ? "tab active" : "tab"}
          onClick={() => setTab("owner")}
        >
          Owner console
        </button>
        <button
          className={tab === "heir" ? "tab active" : "tab"}
          onClick={() => setTab("heir")}
        >
          Heir view
        </button>
        {vault && (
          <button className="tab reset" onClick={forgetVault}>
            Forget this vault
          </button>
        )}
      </div>

      {busy && <div className="flash ok">{busyText[busy] ?? "Proving…"}</div>}
      {flash && !busy && (
        <div className={flash.kind === "ok" ? "flash ok" : "flash err"}>
          {flash.text}
        </div>
      )}
      {lastTx && !busy && (
        <p className="note">
          {lastTx.label}: transaction{" "}
          <code className="inline selectable" title={lastTx.txId}>
            {shortHash(lastTx.txId)}
          </code>{" "}
          in block {lastTx.blockHeight.toLocaleString()} ·{" "}
          {vault && (
            <Link href={`/records?address=${vault.contractAddress}`}>
              see your vault&apos;s on-chain record
            </Link>
          )}
        </p>
      )}

      {tab === "owner" && (
        <section className="panel wide">
          <span className="badge owner">Owner console</span>

          {!vault ? (
            <div className="form">
              <p className="lead">
                Begin your vigil: VIGIL deploys a fresh vault contract to
                Midnight Preprod just for you, then arms it. Your identity,
                your heir&apos;s identity, and the balance go on chain as
                commitments. Nothing readable.
              </p>
              <label>
                Vigil window (seconds)
                <input
                  value={windowSec}
                  onChange={(e) => setWindowSec(e.target.value)}
                  inputMode="numeric"
                />
              </label>
              <label>
                Initial balance (private)
                <input
                  value={initialBalance}
                  onChange={(e) => setInitialBalance(e.target.value)}
                  inputMode="numeric"
                />
              </label>
              <label>
                Legacy note (released only to the heir)
                <input value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <button
                className="cta primary"
                onClick={createVault}
                disabled={busy !== null}
              >
                {busy === "new"
                  ? "Deploying on Preprod…"
                  : "Deploy and arm my vault"}
              </button>
              <p className="hint">
                Two on-chain transactions: deploy, then arm. Expect about 90
                seconds while the proofs are generated.
              </p>
            </div>
          ) : claimed ? (
            <div className="memorial">
              <p>
                The vigil has ended. The estate passed to the heir, whose
                claim receipt is now the only trace on chain:
              </p>
              <code className="inline">{led ? shortHash(led.claimReceipt) : ""}</code>
              <p className="hint">
                This vault is closed forever; the contract accepts no further
                proofs. Forget it above and begin a new vigil whenever you
                like.
              </p>
            </div>
          ) : (
            <div className="armed">
              <p className="note">
                Your vault contract:{" "}
                <code className="inline selectable" title={vault.contractAddress}>
                  {vault.contractAddress}
                </code>{" "}
                ·{" "}
                <Link href={`/records?address=${vault.contractAddress}`}>
                  on-chain record
                </Link>
              </p>
              <div className="countdown">
                <span className="cd-label">
                  {lapsed ? "The vigil has lapsed" : "Vigil lapses in"}
                </span>
                <span className={lapsed ? "cd-time danger" : "cd-time"}>
                  {led
                    ? lapsed
                      ? "the heir may claim"
                      : fmtSeconds(remaining)
                    : "reading chain…"}
                </span>
              </div>
              <button
                className="pulse-btn"
                onClick={pulse}
                disabled={busy !== null}
                title="Prove you hold the owner key; reveal nothing else"
              >
                {busy === "pulse" ? "Proving…" : "Keep Vigil"}
              </button>
              <p className="hint">
                Each pulse proves knowledge of the owner key on chain and
                resets the clock. The chain sees a counter tick. Nothing
                else.
              </p>

              <div className="ops">
                <div className="op">
                  <h3>Deposit (private)</h3>
                  <input
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                    inputMode="numeric"
                  />
                  <button
                    className="cta ghost"
                    onClick={deposit}
                    disabled={busy !== null}
                  >
                    {busy === "deposit" ? "Proving…" : "Roll commitment forward"}
                  </button>
                </div>
                <div className="op">
                  <h3>Prove funded &ge; threshold</h3>
                  <input
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                    inputMode="numeric"
                  />
                  <button
                    className="cta ghost"
                    onClick={attest}
                    disabled={busy !== null}
                  >
                    {busy === "attest" ? "Proving…" : "Attest publicly"}
                  </button>
                </div>
              </div>

              <div className="secret-box">
                <h3>Heir secret (hand this to your heir, off-chain)</h3>
                <code className="inline selectable">{vault.heirSecret}</code>
              </div>
            </div>
          )}
        </section>
      )}

      {tab === "heir" && (
        <section className="panel wide">
          <span className="badge heir">Heir view</span>
          {claimedNote ? (
            <div className="memorial">
              <p>The legacy note, released by the contract:</p>
              <blockquote className="note-reveal">{claimedNote}</blockquote>
              {led && (
                <p className="hint">
                  Claim receipt on chain:{" "}
                  <code className="inline">{shortHash(led.claimReceipt)}</code>
                </p>
              )}
            </div>
          ) : !vault ? (
            <div className="form">
              <p className="lead">
                No vault in this browser yet. The owner deploys and arms the
                vault, then hands the heir secret over off-chain. Come back
                with that secret when the vigil lapses.
              </p>
            </div>
          ) : (
            <div className="form">
              <p className="lead">
                Until claim day you are a stranger to this chain: the ledger
                below is everything you can see. When the vigil lapses,
                prove knowledge of your secret and claim, on chain.
              </p>
              {armed && (
                <p className="hint">
                  {lapsed
                    ? "The vigil has lapsed. The claim window is open."
                    : `The vigil holds for another ${fmtSeconds(remaining)}. A claim now will be rejected by the contract itself; try it.`}
                </p>
              )}
              <label>
                Heir secret
                <input
                  value={heirInput}
                  onChange={(e) => setHeirInput(e.target.value)}
                  placeholder="64 hex characters"
                  spellCheck={false}
                />
              </label>
              <button
                className="cta primary"
                onClick={claim}
                disabled={busy !== null || heirInput.trim().length !== 64}
              >
                {busy === "claim" ? "Proving…" : "Claim the estate"}
              </button>
            </div>
          )}
        </section>
      )}

      {vault && (
        <section className="ledger">
          <h2>What the chain sees</h2>
          <p className="note">
            The complete public state of your vault at{" "}
            <code className="inline" title={vault.contractAddress}>
              {shortHash(vault.contractAddress)}
            </code>{" "}
            on Midnight Preprod, read from the network indexer and
            deserialized through the contract runtime. Every identity and
            amount is a commitment; this is all a stranger, an exchange, or
            a court ever sees.
          </p>
          <table>
            <tbody>
              <tr>
                <td className="k">state</td>
                <td className="v">{led ? led.state : "reading chain…"}</td>
              </tr>
              <tr>
                <td className="k">ownerCommit</td>
                <td className="v" title={led?.ownerCommit ?? ""}>
                  {led ? chainHash(led.ownerCommit) : "…"}
                </td>
              </tr>
              <tr>
                <td className="k">heirCommit</td>
                <td className="v" title={led?.heirCommit ?? ""}>
                  {led ? chainHash(led.heirCommit) : "…"}
                </td>
              </tr>
              <tr>
                <td className="k">balanceCommit</td>
                <td className="v" title={led?.balanceCommit ?? ""}>
                  {led ? chainHash(led.balanceCommit) : "…"}
                </td>
              </tr>
              <tr>
                <td className="k">lastPulse</td>
                <td className="v">{led?.lastPulse ?? "…"}</td>
              </tr>
              <tr>
                <td className="k">vigilWindow</td>
                <td className="v">{led?.vigilWindow ?? "…"}</td>
              </tr>
              <tr>
                <td className="k">pulses</td>
                <td className="v">{led?.pulses ?? "…"}</td>
              </tr>
              <tr>
                <td className="k">attestedFloor</td>
                <td className="v">
                  {led && led.attestedFloor !== "0"
                    ? `${Number(led.attestedFloor).toLocaleString()} (the only number the owner chose to reveal)`
                    : "0 (nothing attested)"}
                </td>
              </tr>
              <tr>
                <td className="k">legacyNote</td>
                <td className="v">
                  {led?.legacyNotePresent
                    ? "opaque blob (present, unreadable)"
                    : "(none)"}
                </td>
              </tr>
              <tr>
                <td className="k">claimReceipt</td>
                <td className="v" title={led?.claimReceipt ?? ""}>
                  {led ? chainHash(led.claimReceipt) : "…"}
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      <footer className="footer">
        Every action on this page is a real transaction on Midnight Preprod,
        proved by the compiled VIGIL circuits (arm, keepVigil, deposit,
        proveFunded, claim). Assertions you see on failure are the
        contract&apos;s own, enforced by the protocol.
      </footer>
    </main>
  );
}

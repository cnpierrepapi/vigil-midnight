"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

// ---------- wire types (mirrors lib/vault-engine.ts) ----------

type WireSecrets = {
  ownerSecretKey: string;
  heirSecret: string;
  balance: string;
  balanceSalt: string;
};

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

type VaultResponse = {
  ok: boolean;
  error?: string;
  journal: unknown[];
  ledger: WireLedger | null;
  result?: string;
  serverTime: number;
};

type ChainLedgerResponse = {
  ok: boolean;
  error?: string;
  network: "preprod";
  contractAddress: string | null;
  ledger: WireLedger | null;
  fetchedAt: number;
};

// ---------- helpers ----------

const ZERO64 = "0".repeat(64);

function randomHex32(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function shortHash(hex: string): string {
  if (!hex || hex === ZERO64) return "(unset)";
  return `0x${hex.slice(0, 10)}…${hex.slice(-6)}`;
}

// The live chain table distinguishes "genuinely all zeros on chain" from
// the sim table's "(unset)": a fresh contract really does hold 32 zero
// bytes in every commitment field.
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

const STORE_JOURNAL = "vigil.journal";
const STORE_OWNER = "vigil.ownerSecrets";
const STORE_HEIR = "vigil.heirSecret";

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
  | { status: "connected"; name: string; address: string; proverServerUri?: string }
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
  const [journal, setJournal] = useState<unknown[]>([]);
  const [led, setLed] = useState<WireLedger | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [claimedNote, setClaimedNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const clockOffset = useRef(0);
  const hydrated = useRef(false);

  // owner secrets live only in this browser
  const [ownerSecrets, setOwnerSecrets] = useState<WireSecrets | null>(null);
  const [heirSecret, setHeirSecret] = useState<string>("");

  // live on-chain state of the deployed preprod contract (read-only)
  const [chain, setChain] = useState<ChainLedgerResponse | null>(null);
  const [chainBusy, setChainBusy] = useState(false);

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
      const api = await found.api.connect("preprod");
      const [address] = await api.getShieldedAddresses();
      const config = await api.getConfiguration();
      setWallet({
        status: "connected",
        name: found.name,
        address: address ?? "(no address)",
        proverServerUri: config.proverServerUri,
      });
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Wallet declined the connection";
      // "Remote API ... was shutdown" is the Lace extension's background
      // worker going idle mid-handshake, not a DApp-side failure
      const message = /shutdown|no longer be used/i.test(raw)
        ? "Lace's background process was asleep. Open the Lace extension, unlock it, then press Connect again."
        : raw;
      setWallet({ status: "error", message });
    }
  }, []);

  const refreshChain = useCallback(async () => {
    setChainBusy(true);
    try {
      const res = await fetch("/api/chain", { cache: "no-store" });
      setChain((await res.json()) as ChainLedgerResponse);
    } catch {
      setChain(null);
    } finally {
      setChainBusy(false);
    }
  }, []);

  useEffect(() => {
    refreshChain();
  }, [refreshChain]);

  // form state
  const [windowSec, setWindowSec] = useState("90");
  const [initialBalance, setInitialBalance] = useState("100000");
  const [note, setNote] = useState("the key to the estate");
  const [depositAmount, setDepositAmount] = useState("50000");
  const [threshold, setThreshold] = useState("50000");
  const [heirInput, setHeirInput] = useState("");

  // 1s clock for the countdown
  useEffect(() => {
    const t = setInterval(
      () => setNow(Math.floor(Date.now() / 1000) + clockOffset.current),
      1000,
    );
    return () => clearInterval(t);
  }, []);

  const post = useCallback(
    async (action: Record<string, unknown>): Promise<VaultResponse | null> => {
      setBusy(true);
      setFlash(null);
      try {
        const res = await fetch("/api/vault", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ journal, action }),
        });
        const data: VaultResponse = await res.json();
        clockOffset.current = data.serverTime - Math.floor(Date.now() / 1000);
        setNow(data.serverTime);
        if (data.ledger) setLed(data.ledger);
        if (data.ok) {
          setJournal(data.journal);
          localStorage.setItem(STORE_JOURNAL, JSON.stringify(data.journal));
        } else if (data.error) {
          setFlash({ kind: "err", text: data.error });
        }
        return data;
      } catch (e) {
        setFlash({
          kind: "err",
          text: e instanceof Error ? e.message : String(e),
        });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [journal],
  );

  // hydrate from localStorage once
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    try {
      const j = localStorage.getItem(STORE_JOURNAL);
      const o = localStorage.getItem(STORE_OWNER);
      const h = localStorage.getItem(STORE_HEIR);
      if (o) setOwnerSecrets(JSON.parse(o));
      if (h) {
        setHeirSecret(h);
        setHeirInput(h);
      }
      if (j) {
        const parsed = JSON.parse(j) as unknown[];
        setJournal(parsed);
        // replay on the server to rebuild the ledger view
        fetch("/api/vault", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ journal: parsed, action: { kind: "inspect" } }),
        })
          .then((r) => r.json())
          .then((data: VaultResponse) => {
            clockOffset.current =
              data.serverTime - Math.floor(Date.now() / 1000);
            if (data.ledger) setLed(data.ledger);
          })
          .catch(() => undefined);
      }
    } catch {
      // corrupted local state; start fresh
    }
  }, []);

  const resetDemo = () => {
    localStorage.removeItem(STORE_JOURNAL);
    localStorage.removeItem(STORE_OWNER);
    localStorage.removeItem(STORE_HEIR);
    setJournal([]);
    setLed(null);
    setOwnerSecrets(null);
    setHeirSecret("");
    setHeirInput("");
    setClaimedNote(null);
    setFlash(null);
  };

  // ---------- actions ----------

  const arm = async () => {
    const secrets: WireSecrets = {
      ownerSecretKey: randomHex32(),
      heirSecret: randomHex32(),
      balance: initialBalance,
      balanceSalt: randomHex32(),
    };
    const r = await post({
      kind: "arm",
      window: Number(windowSec),
      note,
      secrets,
    });
    if (r?.ok) {
      const ownerOnly = { ...secrets, heirSecret: ZERO64 };
      setOwnerSecrets(ownerOnly);
      setHeirSecret(secrets.heirSecret);
      setHeirInput(secrets.heirSecret);
      localStorage.setItem(STORE_OWNER, JSON.stringify(ownerOnly));
      localStorage.setItem(STORE_HEIR, secrets.heirSecret);
      setFlash({ kind: "ok", text: "The vault is armed. The vigil begins." });
    }
  };

  const pulse = async () => {
    if (!ownerSecrets) return;
    const r = await post({ kind: "keepVigil", secrets: ownerSecrets });
    if (r?.ok) setFlash({ kind: "ok", text: "Pulse recorded. The vigil holds." });
  };

  const deposit = async () => {
    if (!ownerSecrets) return;
    const newSalt = randomHex32();
    const r = await post({
      kind: "deposit",
      amount: depositAmount,
      newSalt,
      secrets: ownerSecrets,
    });
    if (r?.ok) {
      const updated: WireSecrets = {
        ...ownerSecrets,
        balance: (
          BigInt(ownerSecrets.balance) + BigInt(depositAmount)
        ).toString(),
        balanceSalt: newSalt,
      };
      setOwnerSecrets(updated);
      localStorage.setItem(STORE_OWNER, JSON.stringify(updated));
      setFlash({
        kind: "ok",
        text: "Deposit sealed. The commitment rolled forward; the amount stays private.",
      });
    }
  };

  const attest = async () => {
    if (!ownerSecrets) return;
    const r = await post({
      kind: "proveFunded",
      threshold,
      secrets: ownerSecrets,
    });
    if (r?.ok)
      setFlash({
        kind: "ok",
        text: `Attested: the vault holds at least ${Number(threshold).toLocaleString()}. The balance itself stays private.`,
      });
  };

  const claim = async () => {
    const r = await post({ kind: "claim", heirSecret: heirInput.trim() });
    if (r?.ok && r.result !== undefined) {
      setClaimedNote(r.result);
      setFlash({ kind: "ok", text: "The claim proof passed. The estate is yours." });
    }
  };

  // ---------- derived ----------

  const armed = led?.state === "ARMED";
  const claimed = led?.state === "CLAIMED";
  const lapseAt = led ? Number(led.lastPulse) + Number(led.vigilWindow) : 0;
  const remaining = lapseAt - now;
  const lapsed = armed && remaining < 0;

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
          <strong>Demo topology.</strong> You skipped the local proof server,
          so the real compiled VIGIL circuits execute on our server with
          simulated chain settlement, and your demo secrets travel to it. In
          production the proof server runs on your own machine and your
          secrets never leave it.
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
            Set up on Docker
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
            <strong>{wallet.name}</strong> connected:{" "}
            <code className="inline" title={wallet.address}>
              {wallet.address.length > 24
                ? `${wallet.address.slice(0, 14)}…${wallet.address.slice(-8)}`
                : wallet.address}
            </code>
            {wallet.proverServerUri
              ? " · proving locally via your own proof server"
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
        <button className="tab reset" onClick={resetDemo}>
          Reset demo
        </button>
      </div>

      {flash && (
        <div className={flash.kind === "ok" ? "flash ok" : "flash err"}>
          {flash.text}
        </div>
      )}

      {tab === "owner" && (
        <section className="panel wide">
          <span className="badge owner">Owner console</span>

          {!led || led.state === "UNARMED" ? (
            <div className="form">
              <p className="lead">
                Arm the vault: your identity, your heir&apos;s identity, and
                the balance all go on chain as commitments. Nothing readable.
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
              <button className="cta primary" onClick={arm} disabled={busy}>
                {busy ? "Sealing…" : "Arm the vault"}
              </button>
            </div>
          ) : claimed ? (
            <div className="memorial">
              <p>
                The vigil has ended. The estate passed to the heir, whose
                claim receipt is now the only trace:
              </p>
              <code className="inline">{shortHash(led.claimReceipt)}</code>
            </div>
          ) : (
            <div className="armed">
              <div className="countdown">
                <span className="cd-label">
                  {lapsed ? "The vigil has lapsed" : "Vigil lapses in"}
                </span>
                <span className={lapsed ? "cd-time danger" : "cd-time"}>
                  {lapsed ? "the heir may claim" : fmtSeconds(remaining)}
                </span>
              </div>
              <button
                className="pulse-btn"
                onClick={pulse}
                disabled={busy || !ownerSecrets}
                title={
                  ownerSecrets
                    ? "Prove you hold the owner key; reveal nothing else"
                    : "This browser does not hold the owner key"
                }
              >
                {busy ? "Proving…" : "Keep Vigil"}
              </button>
              <p className="hint">
                Each pulse proves knowledge of the owner key and resets the
                clock. The chain sees a counter tick. Nothing else.
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
                    disabled={busy || !ownerSecrets}
                  >
                    Roll commitment forward
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
                    disabled={busy || !ownerSecrets}
                  >
                    Attest publicly
                  </button>
                </div>
              </div>

              {heirSecret && (
                <div className="secret-box">
                  <h3>Heir secret (hand this to your heir, off-chain)</h3>
                  <code className="inline selectable">{heirSecret}</code>
                </div>
              )}
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
                  Claim receipt on chain: <code className="inline">{shortHash(led.claimReceipt)}</code>
                </p>
              )}
            </div>
          ) : (
            <div className="form">
              <p className="lead">
                Until claim day you are a stranger to this chain: the ledger
                below is everything you can see. When the vigil lapses, prove
                knowledge of your secret and claim.
              </p>
              {armed && (
                <p className="hint">
                  {lapsed
                    ? "The vigil has lapsed. The claim window is open."
                    : `The vigil holds for another ${fmtSeconds(remaining)}. A claim now will be rejected by the protocol; try it.`}
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
                disabled={busy || heirInput.trim().length !== 64}
              >
                {busy ? "Proving…" : "Claim the estate"}
              </button>
            </div>
          )}
        </section>
      )}

      <section className="ledger">
        <h2>What the chain sees</h2>
        <p className="note">
          The complete public state. Every identity and amount is a
          commitment; this is all a stranger, an exchange, or a court ever
          sees.
        </p>
        <table>
          <tbody>
            <tr>
              <td className="k">state</td>
              <td className="v">{led ? led.state : "UNARMED (no vault yet)"}</td>
            </tr>
            <tr>
              <td className="k">ownerCommit</td>
              <td className="v" title={led?.ownerCommit ?? ""}>
                {led ? shortHash(led.ownerCommit) : "(unset)"}
              </td>
            </tr>
            <tr>
              <td className="k">heirCommit</td>
              <td className="v" title={led?.heirCommit ?? ""}>
                {led ? shortHash(led.heirCommit) : "(unset)"}
              </td>
            </tr>
            <tr>
              <td className="k">balanceCommit</td>
              <td className="v" title={led?.balanceCommit ?? ""}>
                {led ? shortHash(led.balanceCommit) : "(unset)"}
              </td>
            </tr>
            <tr>
              <td className="k">lastPulse</td>
              <td className="v">{led?.lastPulse ?? "0"}</td>
            </tr>
            <tr>
              <td className="k">vigilWindow</td>
              <td className="v">{led?.vigilWindow ?? "0"}</td>
            </tr>
            <tr>
              <td className="k">pulses</td>
              <td className="v">{led?.pulses ?? "0"}</td>
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
                {led ? shortHash(led.claimReceipt) : "(unset)"}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {chain && chain.ok && chain.ledger && (
        <section className="ledger">
          <h2>Live on Midnight Preprod</h2>
          <p className="note">
            The same contract, deployed for real. This is the public ledger
            of VIGIL at{" "}
            <code className="inline" title={chain.contractAddress ?? ""}>
              {shortHash(chain.contractAddress ?? "")}
            </code>{" "}
            on the Midnight Preprod testnet, read from the network indexer
            and deserialized through the contract runtime.{" "}
            <button
              className="cta ghost small"
              onClick={refreshChain}
              disabled={chainBusy}
            >
              {chainBusy ? "Reading chain…" : "Refresh"}
            </button>{" "}
            <Link href="/records" className="cta ghost small">
              Full on-chain record
            </Link>
          </p>
          <table>
            <tbody>
              <tr>
                <td className="k">state</td>
                <td className="v">{chain.ledger.state}</td>
              </tr>
              <tr>
                <td className="k">ownerCommit</td>
                <td className="v" title={chain.ledger.ownerCommit}>
                  {chainHash(chain.ledger.ownerCommit)}
                </td>
              </tr>
              <tr>
                <td className="k">heirCommit</td>
                <td className="v" title={chain.ledger.heirCommit}>
                  {chainHash(chain.ledger.heirCommit)}
                </td>
              </tr>
              <tr>
                <td className="k">balanceCommit</td>
                <td className="v" title={chain.ledger.balanceCommit}>
                  {chainHash(chain.ledger.balanceCommit)}
                </td>
              </tr>
              <tr>
                <td className="k">lastPulse</td>
                <td className="v">{chain.ledger.lastPulse}</td>
              </tr>
              <tr>
                <td className="k">vigilWindow</td>
                <td className="v">{chain.ledger.vigilWindow}</td>
              </tr>
              <tr>
                <td className="k">pulses</td>
                <td className="v">{chain.ledger.pulses}</td>
              </tr>
              <tr>
                <td className="k">attestedFloor</td>
                <td className="v">{chain.ledger.attestedFloor}</td>
              </tr>
              <tr>
                <td className="k">legacyNote</td>
                <td className="v">
                  {chain.ledger.legacyNotePresent
                    ? "opaque blob (present, unreadable)"
                    : "(none)"}
                </td>
              </tr>
              <tr>
                <td className="k">claimReceipt</td>
                <td className="v" title={chain.ledger.claimReceipt}>
                  {chainHash(chain.ledger.claimReceipt)}
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      <footer className="footer">
        Every action on this page executes a real compiled Compact circuit
        (arm, keepVigil, deposit, proveFunded, claim) through the Midnight
        contract runtime. Assertions you see on failure are the
        contract&apos;s own.
      </footer>
    </main>
  );
}

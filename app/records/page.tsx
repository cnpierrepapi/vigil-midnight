"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type WireLedger = {
  state: "UNARMED" | "ARMED" | "CLAIMED";
  pulses: string;
  attestedFloor: string;
  legacyNotePresent: boolean;
};

type VaultRecord = {
  kind: string;
  txHash: string;
  blockHeight: number;
  timestamp: number;
  ledger: WireLedger;
};

type RecordsResponse = {
  ok: boolean;
  error?: string;
  network?: string;
  contractAddress?: string;
  records: VaultRecord[];
};

const CIRCUIT_LABELS: Record<string, string> = {
  deploy: "Contract deployed",
  arm: "arm: the vault was sealed",
  keepVigil: "keepVigil: heartbeat pulse",
  deposit: "deposit: commitment rolled forward",
  proveFunded: "proveFunded: floor attested",
  claim: "claim: the estate passed",
};

function shortHash(hex: string): string {
  if (!hex) return "";
  return `${hex.slice(0, 10)}…${hex.slice(-8)}`;
}

function fmtTime(millis: number): string {
  return new Date(millis).toUTCString().replace("GMT", "UTC");
}

function ledgerSummary(l: WireLedger): string {
  const bits: string[] = [l.state];
  if (l.state !== "UNARMED") {
    bits.push(`${l.pulses} pulse${l.pulses === "1" ? "" : "s"}`);
    if (l.attestedFloor !== "0")
      bits.push(`floor ${Number(l.attestedFloor).toLocaleString()}`);
    if (l.legacyNotePresent) bits.push("note sealed");
  }
  return bits.join(" · ");
}

export default function RecordsPage() {
  const [data, setData] = useState<RecordsResponse | null>(null);
  const [busy, setBusy] = useState(true);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/records", { cache: "no-store" });
      setData((await res.json()) as RecordsResponse);
    } catch (e) {
      setData({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        records: [],
      });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <main className="shell">
      <header className="masthead">
        <div className="candle">
          <div className="flame" />
          <div className="wax" />
        </div>
        <h1>
          <Link href="/">VIGIL</Link>
        </h1>
        <p className="tagline">
          The vault&apos;s public record on Midnight Preprod.
          <br />
          Every transaction below settled on chain with a zero-knowledge proof.
        </p>
      </header>

      <div className="tabs">
        <Link href="/vault" className="tab">
          Back to the vault
        </Link>
        <button className="tab" onClick={refresh} disabled={busy}>
          {busy ? "Reading chain…" : "Refresh"}
        </button>
      </div>

      <section className="ledger">
        <h2>Vault provenance</h2>
        {data?.contractAddress && (
          <p className="note">
            Contract{" "}
            <code className="inline selectable">{data.contractAddress}</code>{" "}
            on Midnight Preprod, history streamed from the network indexer.
            Each row shows the transaction and the public ledger state it
            left behind. Amounts, identities, and the legacy note never
            appear; that is the point.
          </p>
        )}

        {busy && !data && <p className="note">Reading the chain…</p>}
        {data && !data.ok && (
          <p className="note">Could not read history: {data.error}</p>
        )}
        {data?.ok && data.records.length === 0 && (
          <p className="note">No actions recorded yet.</p>
        )}

        {data?.ok && data.records.length > 0 && (
          <table>
            <thead>
              <tr>
                <td className="k">#</td>
                <td className="k">action</td>
                <td className="k">block</td>
                <td className="k">time</td>
                <td className="k">transaction</td>
                <td className="k">ledger after</td>
              </tr>
            </thead>
            <tbody>
              {data.records.map((r, i) => (
                <tr key={r.txHash + i}>
                  <td className="v">{i + 1}</td>
                  <td className="v">{CIRCUIT_LABELS[r.kind] ?? r.kind}</td>
                  <td className="v">{r.blockHeight.toLocaleString()}</td>
                  <td className="v">{fmtTime(r.timestamp)}</td>
                  <td className="v" title={r.txHash}>
                    <code className="inline selectable">
                      {shortHash(r.txHash)}
                    </code>
                  </td>
                  <td className="v">{ledgerSummary(r.ledger)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <footer className="footer">
        Read-only view. The history is streamed live from the Midnight
        indexer and each state is deserialized through the compiled VIGIL
        contract runtime; nothing on this page is simulated.
      </footer>
    </main>
  );
}

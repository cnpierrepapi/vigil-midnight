// End-to-end test against the LIVE deployment: drives the real compiled
// circuits through /api/vault the same way the browser does.
// Usage: node scripts/e2e-live.mjs [baseUrl]

const BASE = process.argv[2] ?? "https://vigil-midnight.vercel.app";

const hex = (n) =>
  Array.from({ length: 64 }, () => "0123456789abcdef"[(Math.random() * 16) | 0]).join("");

const ownerSecretKey = hex();
const heirSecret = hex();
const balanceSalt = hex();

let journal = [];

async function call(action) {
  const res = await fetch(`${BASE}/api/vault`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ journal, action }),
  });
  const data = await res.json();
  if (data.ok) journal = data.journal;
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(name, cond, detail) {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`${mark}  ${name}${detail ? `  :: ${detail}` : ""}`);
}

const secrets = { ownerSecretKey, heirSecret, balance: "100000", balanceSalt };

// 1. arm with a 8-second window
let r = await call({ kind: "arm", window: 8, note: "the key to the estate", secrets });
check("arm", r.ok && r.ledger?.state === "ARMED", r.error ?? `state=${r.ledger?.state} pulses=${r.ledger?.pulses}`);

// 2. keepVigil
r = await call({ kind: "keepVigil", secrets: { ...secrets, heirSecret: "0".repeat(64) } });
check("keepVigil", r.ok && r.ledger?.pulses === "2", r.error ?? `pulses=${r.ledger?.pulses}`);

// 3. proveFunded 50000
r = await call({ kind: "proveFunded", threshold: "50000", secrets: { ...secrets, heirSecret: "0".repeat(64) } });
check("proveFunded", r.ok && r.ledger?.attestedFloor === "50000", r.error ?? `floor=${r.ledger?.attestedFloor}`);

// 4. proveFunded above balance must FAIL with the contract's own assert
r = await call({ kind: "proveFunded", threshold: "200000", secrets: { ...secrets, heirSecret: "0".repeat(64) } });
check("proveFunded over-balance rejected", !r.ok && /below the attested floor/.test(r.error ?? ""), r.error);

// 5. premature claim must FAIL with the vigil-holds assert
r = await call({ kind: "claim", heirSecret });
check("premature claim rejected", !r.ok && /vigil holds/.test(r.error ?? ""), r.error);

// 6. impostor claim after lapse must FAIL
console.log("     ... waiting 11s for the vigil to lapse ...");
await sleep(11_000);
r = await call({ kind: "claim", heirSecret: hex() });
check("impostor claim rejected", !r.ok && /Not the designated heir/.test(r.error ?? ""), r.error);

// 7. rightful heir claims
r = await call({ kind: "claim", heirSecret });
check(
  "heir claim after lapse",
  r.ok && r.result === "the key to the estate" && r.ledger?.state === "CLAIMED",
  r.error ?? `result=${JSON.stringify(r.result)} state=${r.ledger?.state}`,
);

console.log(failures === 0 ? "\nALL LIVE E2E CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

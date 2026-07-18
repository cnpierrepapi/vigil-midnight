import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// a new vault is two real proofs (~90s) and may queue behind other
// visitors; hold the line open accordingly
export const maxDuration = 300;

const ALLOWED_OPS = new Set(["new", "pulse", "deposit", "attest", "claim"]);

export async function POST(req: NextRequest) {
  const relayerUrl = process.env.RELAYER_URL;
  const relayerToken = process.env.RELAYER_TOKEN;
  if (!relayerUrl || !relayerToken) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "The live relayer is not configured on this deployment. On-chain actions are paused.",
      },
      { status: 503 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const op = typeof body.op === "string" ? body.op : "";
  if (!ALLOWED_OPS.has(op)) {
    return NextResponse.json(
      { ok: false, error: "Unknown op" },
      { status: 400 },
    );
  }

  const base = relayerUrl.replace(/\/$/, "");
  const endpoint =
    op === "new"
      ? `${base}/vault/new`
      : typeof body.contractAddress === "string"
        ? `${base}/vault/act`
        : `${base}/act`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vigil-token": relayerToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(280_000),
      cache: "no-store",
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    return NextResponse.json(
      {
        ok: false,
        error: timedOut
          ? "The proof is taking longer than usual. It may still land; check the record page in a minute."
          : "The live relayer is unreachable right now. On-chain actions are paused.",
      },
      { status: 504 },
    );
  }
}

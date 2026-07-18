import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// real proof generation on the relayer takes ~40-60s per circuit call
export const maxDuration = 120;

const ALLOWED_OPS = new Set(["pulse", "deposit", "attest"]);

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

  let body: { op?: string; amount?: string; threshold?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  if (!body.op || !ALLOWED_OPS.has(body.op)) {
    return NextResponse.json(
      { ok: false, error: "Unknown op" },
      { status: 400 },
    );
  }

  try {
    const res = await fetch(`${relayerUrl.replace(/\/$/, "")}/act`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vigil-token": relayerToken,
      },
      body: JSON.stringify({
        op: body.op,
        amount: body.amount,
        threshold: body.threshold,
      }),
      signal: AbortSignal.timeout(110_000),
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

import { NextRequest, NextResponse } from "next/server";
import { fetchChainLedger } from "@/lib/vault-engine";

export const dynamic = "force-dynamic";

const HEX64 = /^[0-9a-fA-F]{64}$/;

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address") ?? undefined;
  if (address && !HEX64.test(address)) {
    return NextResponse.json(
      { ok: false, error: "Malformed contract address" },
      { status: 400 },
    );
  }
  const result = await fetchChainLedger(address);
  return NextResponse.json(result, { status: 200 });
}

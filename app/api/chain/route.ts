import { NextResponse } from "next/server";
import { fetchChainLedger } from "@/lib/vault-engine";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await fetchChainLedger();
  return NextResponse.json(result, { status: 200 });
}

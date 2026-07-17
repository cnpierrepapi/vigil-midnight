import { NextRequest, NextResponse } from "next/server";
import {
  handleAction,
  type JournalEntry,
  type VaultAction,
} from "@/lib/vault-engine";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { journal?: JournalEntry[]; action?: VaultAction };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const journal = Array.isArray(body.journal) ? body.journal : [];
  const action = body.action;
  if (!action || typeof action !== "object" || !("kind" in action)) {
    return NextResponse.json(
      { ok: false, error: "Missing action" },
      { status: 400 },
    );
  }

  try {
    const response = handleAction(journal, action);
    return NextResponse.json(response);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

// Diagnostic endpoint: GET /api/models/price-debug?provider=...&model=...
// Returns the result of pricingRepo.getPricingForModel(), letting us verify
// the full fallback chain (user override → constants → OpenRouter cache →
// pattern guess). Useful when a model's cost looks wrong — query this
// endpoint to see which resolver returned the price and from what source.
//
// No auth: only returns public price data and ref IDs, no credentials.
import { NextResponse } from "next/server";
import { getPricingForModel } from "@/lib/db";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const provider = searchParams.get("provider") || "";
  const model = searchParams.get("model") || "";
  if (!model) {
    return NextResponse.json({ error: "missing ?model=" }, { status: 400 });
  }
  const pricing = await getPricingForModel(provider, model);
  return NextResponse.json({
    provider,
    model,
    pricing,
    source: pricing?._source || (pricing ? "user-or-constants" : "none"),
  });
}

// Debug endpoint: GET /api/models/price-debug?provider=...&model=...
// Returns the result of pricingRepo.getPricingForModel(), letting us verify
// the full fallback chain (user override → constants → OpenRouter cache).
// TODO: remove or gate behind admin auth once OpenRouter sync stabilizes.
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

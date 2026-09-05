import { getCodexModelCatalog } from "@/lib/codexModels";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const forceRefresh = new URL(request.url).searchParams.get("refresh") === "true";
  try {
    const catalog = await getCodexModelCatalog(undefined, { forceRefresh });
    return Response.json(catalog, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ models: [], source: "unavailable", stale: true }, { status: 503 });
  }
}

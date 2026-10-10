import { NextResponse } from "next/server";
import { setProviderConnectionOrder } from "@/lib/db/index.js";

// PUT /api/providers/reorder — { provider, orderedIds: [id, ...] }
// Writes the whole order at once. Swapping two rows with two independent
// priority PUTs raced: each one renumbered the pool, so the saved order often
// differed from what the dashboard showed.
export async function PUT(request) {
  try {
    const { provider, orderedIds } = await request.json();
    if (typeof provider !== "string" || !provider || !Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== "string")) {
      return NextResponse.json({ error: "provider and orderedIds[] are required" }, { status: 400 });
    }
    const result = await setProviderConnectionOrder(provider, orderedIds);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error reordering connections:", error);
    return NextResponse.json({ error: "Failed to reorder connections" }, { status: 500 });
  }
}

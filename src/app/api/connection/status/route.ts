import { NextResponse } from "next/server";
import { connectionStatus } from "@/lib/connection";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(connectionStatus());
}

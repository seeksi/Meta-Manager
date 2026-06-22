import { NextResponse } from "next/server";
import { verifyConnection } from "@/lib/connection";

export async function POST() {
  return NextResponse.json(await verifyConnection());
}

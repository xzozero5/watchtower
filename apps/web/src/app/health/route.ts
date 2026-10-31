import { NextResponse } from 'next/server';

// Liveness only: no dependency calls, so a slow API or database can never make the container
// look dead. Compose, Cloud Run and the Dockerfile HEALTHCHECK all use this.
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(
    { status: 'ok', service: 'web' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

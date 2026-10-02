export function GET() {
  return new Response(
    "This legacy preview link is no longer supported. Create a new share from the toolbar.",
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

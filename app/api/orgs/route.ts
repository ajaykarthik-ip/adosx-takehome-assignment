import { listOrgs } from "@/lib/queries";

/**
 * GET /api/orgs
 *
 * The orgs (tenants) that exist, so the screen can offer a scope selector.
 * This is the only endpoint that is not org-scoped, because it is the one
 * that tells you which scopes there are. It returns no record data.
 */
export async function GET() {
  try {
    return Response.json({ orgs: listOrgs() });
  } catch (error) {
    return Response.json({ error: describeError(error) }, { status: 500 });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

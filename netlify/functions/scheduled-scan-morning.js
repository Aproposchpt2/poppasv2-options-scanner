// Temporary schedule retired after successful 504-symbol validation.
// Permanent morning wrappers remain authoritative.
export default async () => new Response(null, { status: 204 });

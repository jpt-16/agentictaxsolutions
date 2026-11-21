/** A token is void if the person signed out after it was issued. Tokens without an issue time are void once any sign-out happened. */
export function isRevoked(issuedAtMs: unknown, validAfterMs: number | null): boolean {
  if (validAfterMs === null) return false;
  return typeof issuedAtMs !== "number" || issuedAtMs < validAfterMs;
}


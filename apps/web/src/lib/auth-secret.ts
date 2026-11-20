/** Known example values must never sign real sessions: anyone who has read the repository could forge one. */
const PLACEHOLDER = /change-?me|example|placeholder|secret-?secret|ci-only|^(.)\1+$/i;

export function checkAuthSecret(s: string | undefined, production: boolean): string | null {
  if (!s || s.length < 32) return "AUTH_SECRET must be set to a random string of at least 32 characters.";
  if (production) {
    if (PLACEHOLDER.test(s)) return "AUTH_SECRET is a placeholder value. Generate one, e.g. `openssl rand -base64 48`.";
    if (new Set(s).size < 16) return "AUTH_SECRET is too predictable (too few distinct characters). Generate a random value.";
  }
  return null;
}

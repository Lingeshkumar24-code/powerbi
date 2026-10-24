import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { TokenVerifier, VerifiedIdentity } from "./auth.js";

/**
 * Firebase ID token verification against Google's rotating public keys.
 *
 * Only the project id is needed: no service-account key has to live on the
 * server. `keys` is injectable so tests can verify tokens with a local JWKS.
 */
const FIREBASE_JWKS = new URL(
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
);

let remoteKeys: JWTVerifyGetKey | null = null;

export function createFirebaseVerifier(projectId: string, keys?: JWTVerifyGetKey): TokenVerifier {
  if (!projectId) throw new Error("Firebase project id is required");
  const keySet = keys ?? (remoteKeys ??= createRemoteJWKSet(FIREBASE_JWKS));
  const issuer = `https://securetoken.google.com/${projectId}`;
  return async (token: string): Promise<VerifiedIdentity> => {
    const { payload } = await jwtVerify(token, keySet, {
      issuer,
      audience: projectId,
      algorithms: ["RS256"],
      clockTolerance: 30,
    });
    const uid = typeof payload.sub === "string" ? payload.sub : "";
    const email = typeof payload.email === "string" ? payload.email : "";
    if (!uid) throw new Error("Firebase token is missing sub");
    if (!email) throw new Error("Firebase token is missing email");
    return {
      uid,
      email,
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === "string" ? payload.name : undefined,
      picture: typeof payload.picture === "string" ? payload.picture : undefined,
    };
  };
}

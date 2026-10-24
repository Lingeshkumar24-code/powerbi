import { describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { createFirebaseVerifier } from "../server/firebase";

const projectId = "powerbicraft-test";
const issuer = `https://securetoken.google.com/${projectId}`;

async function fixture() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] });
  const sign = (claims: Record<string, unknown>, options: { audience?: string; expires?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(options.audience ?? projectId)
      .setSubject(String(claims.sub ?? "firebase-uid-1"))
      .setIssuedAt()
      .setExpirationTime(options.expires ?? "1h")
      .sign(privateKey);
  return { verify: createFirebaseVerifier(projectId, keys), sign };
}

describe("Firebase ID token verification", () => {
  it("accepts a token signed by the project key and extracts claims", async () => {
    const { verify, sign } = await fixture();
    const token = await sign({
      sub: "firebase-uid-1",
      email: "ada@example.com",
      email_verified: true,
      name: "Ada Lovelace",
    });
    await expect(verify(token)).resolves.toMatchObject({
      uid: "firebase-uid-1",
      email: "ada@example.com",
      emailVerified: true,
      name: "Ada Lovelace",
    });
  });

  it("keeps unverified email state visible to the API layer", async () => {
    const { verify, sign } = await fixture();
    const token = await sign({ email: "new@example.com", email_verified: false });
    await expect(verify(token)).resolves.toMatchObject({ emailVerified: false });
  });

  it("rejects wrong audience, missing email and expired tokens", async () => {
    const { verify, sign } = await fixture();
    const wrongAudience = await sign({ email: "a@example.com" }, { audience: "someone-else" });
    await expect(verify(wrongAudience)).rejects.toThrow();

    const noEmail = await sign({});
    await expect(verify(noEmail)).rejects.toThrow(/email/i);

    const expired = await sign({ email: "a@example.com" }, { expires: "-5m" });
    await expect(verify(expired)).rejects.toThrow();
  });

  it("rejects a token from another issuer", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const verify = createFirebaseVerifier(
      projectId,
      createLocalJWKSet({ keys: [{ ...jwk, kid: "other", alg: "RS256", use: "sig" }] }),
    );
    const token = await new SignJWT({ email: "a@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "other" })
      .setIssuer("https://securetoken.google.com/another-project")
      .setAudience(projectId)
      .setSubject("uid")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    await expect(verify(token)).rejects.toThrow();
  });
});

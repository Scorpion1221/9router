import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { createZedNativeAuthData, decryptZedAccessToken } from "../../open-sse/shared/zedAuth.js";

// Native Zed tokens encode 48 random bytes, not arbitrary plaintext strings.
const token = Buffer.alloc(48, 0xfb).toString("base64url");
const auth = createZedNativeAuthData({}, { nativeAppPort: 1 });
const publicKey = crypto.createPublicKey({ key: Buffer.from(auth.publicKey, "base64url"), format: "der", type: "pkcs1" });

afterEach(() => vi.restoreAllMocks());

describe("Zed native token validation", () => {
  it.each([crypto.constants.RSA_PKCS1_OAEP_PADDING, crypto.constants.RSA_PKCS1_PADDING])("preserves valid token bytes with padding %s", (padding) => {
    const encrypted = crypto.publicEncrypt({ key: publicKey, padding, oaepHash: "sha256" }, Buffer.from(token));
    expect(decryptZedAccessToken(encrypted.toString("base64url"), auth.privateKeyVerifier)).toBe(token);
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["short ASCII", Buffer.from("ABCD")],
    ["short token", Buffer.from("A".repeat(63))],
    ["long token", Buffer.from("A".repeat(65))],
    ["invalid alphabet", Buffer.from("+".repeat(64))],
    ["invalid UTF-8", Buffer.alloc(64, 0xff)],
    ["embedded newline", Buffer.from("A".repeat(63) + "\n")],
    ["trailing newline", Buffer.from("A".repeat(64) + "\n")],
  ])("rejects %s synthetic plaintext from implicit rejection", (_label, bytes) => {
    const decrypt = vi.spyOn(crypto, "privateDecrypt")
      .mockImplementationOnce(() => { throw new Error("OAEP failed"); })
      .mockReturnValueOnce(bytes);
    expect(() => decryptZedAccessToken("AA", auth.privateKeyVerifier)).toThrow("Failed to decrypt Zed access token");
    expect(decrypt.mock.calls.map(([options]) => options.padding)).toEqual([
      crypto.constants.RSA_PKCS1_OAEP_PADDING, crypto.constants.RSA_PKCS1_PADDING,
    ]);
  });

  it("does not downgrade a successfully decrypted but malformed OAEP token", () => {
    const decrypt = vi.spyOn(crypto, "privateDecrypt").mockReturnValueOnce(Buffer.from("short"));
    expect(() => decryptZedAccessToken("AA", auth.privateKeyVerifier)).toThrow("Failed to decrypt Zed access token");
    expect(decrypt).toHaveBeenCalledOnce();
  });

  it.each(["", "AA", "not-base64!"])("rejects malformed ciphertext %j", (ciphertext) => {
    expect(() => decryptZedAccessToken(ciphertext, auth.privateKeyVerifier)).toThrow("Failed to decrypt Zed access token");
  });
});

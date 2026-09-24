import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function getEncryptionKey() {
  const secret = process.env.GITHUB_TOKEN_ENCRYPTION_KEY || process.env.GITHUB_CLIENT_SECRET;
  if (!secret) {
    throw new Error("Set GITHUB_TOKEN_ENCRYPTION_KEY or GITHUB_CLIENT_SECRET to encrypt GitHub tokens.");
  }
  return createHash("sha256").update(secret).digest();
}

export function encryptGithubToken(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decryptGithubToken(encryptedToken: string) {
  const [encodedIv, encodedTag, encodedCiphertext] = encryptedToken.split(".");
  if (!encodedIv || !encodedTag || !encodedCiphertext) {
    throw new Error("Stored GitHub token has an invalid format.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(encodedIv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

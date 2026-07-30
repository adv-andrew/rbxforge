const SECRET_LIKE_CONTENT =
  /(?:authorization["']?\s*:\s*["']?\s*(?:bearer|basic)\b|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|credentials?|private[_-]?key)\b["']?\s*[:=]\s*["']?[^\s"',}]{4,}|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{6,})/iu;
const PASSWORD_ASSIGNMENT =
  /(?:^|[^A-Za-z0-9_])[A-Za-z0-9_-]*(?:password|passwd)[A-Za-z0-9_-]*["']?\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s"',;}\]]+)/iu;
const SENSITIVE_KEY = /key|token|secret|auth|credential|source|script|base64|prompt|arguments|password|passwd/iu;
const SENSITIVE_BASENAME = /^(?:credentials?|secrets?)(?:[._-].+)?$/iu;
const SENSITIVE_IDENTITY_FILE = /^id_(?:rsa|ed25519)(?:[._-].+)?$/iu;
const SENSITIVE_EXTENSION = /\.(?:pem|key|p12|pfx|crt|cer|der)$/iu;

export function isSecretLikeContent(value: string): boolean {
  return SECRET_LIKE_CONTENT.test(value) || PASSWORD_ASSIGNMENT.test(value);
}

export function isSensitiveKey(value: string): boolean {
  return SENSITIVE_KEY.test(value);
}

export function isSensitivePath(value: string): boolean {
  return value.split(/[\\/]+/u).some((segment) => {
    const normalized = segment.toLowerCase();
    return (
      normalized.startsWith(".env") ||
      normalized === ".aws" ||
      normalized === ".ssh" ||
      SENSITIVE_BASENAME.test(segment) ||
      SENSITIVE_IDENTITY_FILE.test(segment) ||
      SENSITIVE_EXTENSION.test(segment)
    );
  });
}

import { describe, expect, test } from "vitest";

import { isSecretLikeContent, isSensitiveKey, isSensitivePath } from "./security-policy.js";

describe("shared security policy", () => {
  test("detects bearer, credential, private-key, password and passwd assignments", () => {
    const sensitive = [
      ["Authorization", "Bearer bearer-policy-sentinel"].join(": "),
      "api_key=api-policy-sentinel",
      'credential: "credential-policy-sentinel"',
      "private_key=private-policy-sentinel",
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
      "password=password-policy-sentinel",
      'PASSWORD: "uppercase-password-policy-sentinel"',
      '{"passwd":"passwd-policy-sentinel"}',
      '{"PaSsWd" = "mixed-passwd-policy-sentinel"}',
    ];

    for (const value of sensitive) {
      const result = isSecretLikeContent(value);
      expect(result, value).toBe(true);
      expect(typeof result).toBe("boolean");
    }
    expect({
      shortPassword: isSecretLikeContent("password=abc"),
      oneCharacterPasswd: isSecretLikeContent("passwd=x"),
      underscoredPassword: isSecretLikeContent("DB_PASSWORD=q"),
      underscoredPasswdJson: isSecretLikeContent('{"db_passwd":"y"}'),
      camelPassword: isSecretLikeContent("dbPassword=z"),
    }).toEqual({
      shortPassword: true,
      oneCharacterPasswd: true,
      underscoredPassword: true,
      underscoredPasswdJson: true,
      camelPassword: true,
    });
    expect(isSecretLikeContent("The password policy requires rotation.")).toBe(false);
  });

  test("classifies every recursively redacted key class including password and passwd", () => {
    for (const key of [
      "apiKey",
      "token",
      "secret",
      "authorization",
      "authHeader",
      "credential",
      "source",
      "script",
      "base64",
      "prompt",
      "arguments",
      "password",
      "PASSWD",
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    expect(isSensitiveKey("harmless")).toBe(false);
  });

  test("matches sensitive whole path segments and suffixes without substring false positives", () => {
    for (const path of [
      "credentials.json",
      "config/credentials.prod.json",
      String.raw`config\credentials-prod`,
      "config/credentials_backup",
      "secrets.json",
      "config/secret.prod",
      String.raw`config\secrets-prod`,
      "config/secrets_backup",
      "id_rsa.pub",
      "keys/id_rsa-backup",
      String.raw`keys\id_ed25519_backup`,
      ".env",
      "config/.env.local",
      "config/.ENV.production",
      ".aws/config",
      ".AWS/config",
      String.raw`.ssh\config`,
      String.raw`.SSH\config`,
      "keys/client.pem",
      "keys/client.key",
      "keys/client.p12",
      "keys/client.pfx",
      "certificates/client.crt",
      "certificates/client.cer",
    ]) {
      expect(isSensitivePath(path), path).toBe(true);
    }

    for (const path of [
      "mycredentials.lua",
      "config/mycredentials.json",
      "notsecretsauce.json",
      "config/credentialsHelper.lua",
      "keys/valid_id_rsa_notes.lua",
      "certificates/client.certificate.txt",
    ]) {
      expect(isSensitivePath(path), path).toBe(false);
    }
  });
});

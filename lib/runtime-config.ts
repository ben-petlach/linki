import path from "node:path";

const placeholder = /^(?:changeme|replace(?:-?me)?|your[_ -]?(?:password|secret|value)|example(?:[_ -].*)?|synthetic-ci-secret-never-use-in-production|test(?:[_ -]?(?:password|secret))?)$/i;

export function validateProductionRuntime(env: NodeJS.ProcessEnv = process.env): string[] {
  const errors: string[] = [];
  const secret = env.NEXTAUTH_SECRET?.trim() ?? "";
  const password = env.AUTH_PASSWORD?.trim() ?? "";
  const publicUrl = env.NEXTAUTH_URL?.trim() ?? "";

  if (secret.length < 32 || placeholder.test(secret) || /^(.)\1+$/.test(secret)) {
    errors.push("NEXTAUTH_SECRET must be a non-placeholder secret of at least 32 characters");
  }
  if (password.length < 16 || placeholder.test(password) || /^(.)\1+$/.test(password)) {
    errors.push("AUTH_PASSWORD must be a non-placeholder password of at least 16 characters");
  }
  try {
    const url = new URL(publicUrl);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!(["https:", "http:"].includes(url.protocol) && (url.protocol === "https:" || local)) || url.username || url.password) {
      errors.push("NEXTAUTH_URL must be HTTPS, or HTTP on localhost, without embedded credentials");
    }
  } catch {
    errors.push("NEXTAUTH_URL must be an absolute public URL");
  }
  if (env.LINKI_DB_PATH && !path.isAbsolute(env.LINKI_DB_PATH)) {
    errors.push("LINKI_DB_PATH must be absolute in production");
  }
  return errors;
}

export function assertProductionRuntime(env: NodeJS.ProcessEnv = process.env): void {
  const errors = validateProductionRuntime(env);
  if (errors.length) throw new Error(`Production configuration invalid: ${errors.join("; ")}`);
}

export function runtimeIdentity(env: NodeJS.ProcessEnv = process.env) {
  return {
    version: env.APP_VERSION || "dev",
    sourceCommit: env.LINKI_SOURCE_COMMIT || "unknown",
    imageDigest: env.LINKI_IMAGE_DIGEST || "unavailable",
  };
}

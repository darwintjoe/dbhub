import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface SetupCodeResult {
  code: string;
  filePath: string;
  expiresAt: string;
}

export function setupCodeHash(code: string): string {
  return crypto.createHash("sha256").update(code, "utf8").digest("hex");
}

export function generateFirstRunSetupCode(
  db: any,
  dataDir: string,
  opts: { emit?: (line: string) => void; logger?: any; now?: Date } = {},
): SetupCodeResult | null {
  const emit = opts.emit ?? ((line: string) => { process.stdout.write(line + "\n"); });
  const logger = opts.logger;
  try {
    const cred = db.prepare("SELECT 1 FROM admin_credentials WHERE id=1").get();
    const codeRow = db.prepare("SELECT value FROM app_state WHERE key='setup.code_hash'").get();
    const expiresRow = db.prepare("SELECT value FROM app_state WHERE key='setup.code_expires_at'").get() as { value: string } | undefined;
    const unexpired = codeRow && expiresRow && Date.now() < Date.parse(expiresRow.value);
    if (cred || unexpired) return null;

    const codeRaw = crypto.randomBytes(16).toString("hex").toUpperCase();
    const code = codeRaw.match(/.{1,8}/g)!.join("-");
    const hash = setupCodeHash(code);
    const now = opts.now ?? new Date();
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
    const at = now.toISOString();

    db.prepare("INSERT OR REPLACE INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_hash", hash, at);
    db.prepare("INSERT OR REPLACE INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_created_at", at, at);
    db.prepare("INSERT OR REPLACE INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_expires_at", expiresAt, at);
    db.prepare("INSERT OR REPLACE INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_attempts", "0", at);

    const filePath = path.join(dataDir, "setup-code.txt");
    const qrPayload = JSON.stringify({ v: 1, type: "dbhub-setup", code });
    try {
      fs.writeFileSync(filePath, code + "\n" + "DBHUB_SETUP_QR=" + qrPayload + "\n", { mode: 0o600 });
    } catch {
      // file write is best-effort; stdout line remains authoritative
    }

    // INTENTIONAL EMISSION: this single stdout line is the only place the code is printed.
    emit("DBHub first-run setup code (shown once): " + code + " DBHUB_SETUP_QR=" + qrPayload);
    return { code, filePath, expiresAt };
  } catch (e) {
    logger?.warn?.({ err: e }, "setup code init failed");
    return null;
  }
}

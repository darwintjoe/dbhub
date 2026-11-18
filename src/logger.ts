import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import type { Config } from "./config";

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function dayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function createLogger(config: Config) {
  ensureDir(config.logDir);
  const retentionDays = 30;
  let currentDay = dayStamp();
  let stream = fs.createWriteStream(path.join(config.logDir, `hub-${currentDay}.log`), { flags: "a" });

  // Rotate at midnight-ish: check on every write.
  const rotating = {
    write(chunk: string) {
      const d = dayStamp();
      if (d !== currentDay) {
        try {
          stream.end();
        } catch {
          // ignore
        }
        currentDay = d;
        stream = fs.createWriteStream(path.join(config.logDir, `hub-${currentDay}.log`), { flags: "a" });
      }
      return stream.write(chunk);
    },
  };

  // Retention sweep.
  function sweepRetention() {
    try {
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      for (const f of fs.readdirSync(config.logDir)) {
        if (!/^hub-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
        const fp = path.join(config.logDir, f);
        const st = fs.statSync(fp);
        if (st.mtimeMs < cutoff) fs.unlinkSync(fp);
      }
    } catch {
      // best effort
    }
  }
  sweepRetention();
  setInterval(sweepRetention, 24 * 60 * 60 * 1000).unref();

  const logger = pino(
    {
      level: process.env.LOG_LEVEL || "info",
      base: { service: "fazai-hub", version: "0.1.1" },
      redact: {
        paths: ["req.headers.authorization", "*.token", "*.payload", "payload", "token"],
        censor: "[redacted]",
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream([
      { stream: process.stdout },
      { stream: rotating as unknown as NodeJS.WritableStream },
    ]),
  );

  return logger;
}

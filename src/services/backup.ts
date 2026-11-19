import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Config } from "../config";

const BACKUP_RE = /^hub-\d{8}-\d{6}\.sqlite$/;

export class BackupService {
  private readonly db: Database.Database;
  private readonly config: Config;
  private running = false;

  constructor(db: Database.Database, config: Config) {
    this.db = db;
    this.config = config;
  }

  dir(): string {
    const d = this.config.backup?.dir || path.join(this.config.dataDir, "backups");
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  private filename(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `hub-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.sqlite`;
  }

  async create(): Promise<{ name: string; path: string }> {
    if (this.running) throw new Error("BACKUP-001");
    this.running = true;
    try {
      const dir = this.dir();
      fs.mkdirSync(dir, { recursive: true });
      const name = this.filename();
      const dest = path.join(dir, name);
      await this.db.backup(dest);
      this.prune();
      return { name, path: dest };
    } finally {
      this.running = false;
    }
  }

  list(): { name: string; size: number; mtimeMs: number }[] {
    const dir = this.dir();
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => BACKUP_RE.test(f))
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { name: f, size: st.size, mtimeMs: st.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      return [];
    }
  }

  resolve(name: string): string {
    if (!BACKUP_RE.test(name)) throw new Error("BACKUP-001");
    const dir = path.resolve(this.dir());
    const fp = path.resolve(dir, path.basename(name));
    if (!fp.startsWith(dir + path.sep)) throw new Error("BACKUP-001");
    if (!fs.existsSync(fp)) throw new Error("BACKUP-001");
    return fp;
  }

  private prune(): void {
    const maxFiles = Number(this.config.backup?.maxFiles ?? 20);
    const retentionDays = Number(this.config.backup?.retentionDays ?? 14);
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const dir = this.dir();
    let files = fs
      .readdirSync(dir)
      .filter((f) => BACKUP_RE.test(f))
      .map((f) => ({ name: f, path: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    // retention by days
    files = files.filter((f) => {
      if (f.mtime < cutoff) {
        try { fs.unlinkSync(f.path); } catch { /* ignore */ }
        return false;
      }
      return true;
    });
    while (files.length > maxFiles) {
      const old = files.pop();
      if (old) {
        try { fs.unlinkSync(old.path); } catch { /* ignore */ }
      }
    }
  }
}

export function backupPattern(): RegExp {
  return BACKUP_RE;
}

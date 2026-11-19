import fs from "node:fs";
import path from "node:path";

const FILE_RE = /^hub-\d{4}-\d{2}-\d{2}\.log$/;

export interface LogsService {
  dir: string;
}

export function listLogFiles(dir: string): { name: string; size: number; mtimeMs: number }[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => FILE_RE.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, size: st.size, mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

export function readLogs(opts: { dir: string; file?: string; lines?: number; level?: string; q?: string }): {
  file: string | null;
  files: { name: string; size: number }[];
  lines: string[];
  parsed: any[];
} {
  const files = listLogFiles(opts.dir);
  let selected: string | undefined = opts.file;
  if (!selected) selected = files[0]?.name;
  if (selected && !FILE_RE.test(selected)) {
    throw new Error("LOG-001");
  }
  const filesOut = files.map((f) => ({ name: f.name, size: f.size }));
  if (!selected) return { file: null, files: filesOut, lines: [], parsed: [] };
  const fp = path.join(opts.dir, selected);
  // path safety
  if (path.basename(fp) !== selected || !fp.startsWith(path.resolve(opts.dir))) {
    throw new Error("LOG-001");
  }
  const maxBytes = 512 * 1024;
  const st = fs.statSync(fp);
  const start = Math.max(0, st.size - maxBytes);
  const fd = fs.openSync(fp, "r");
  const buf = Buffer.alloc(Math.min(st.size, maxBytes));
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const text = buf.toString("utf8");
  const allLines = text.split(/\r?\n/).filter(Boolean);
  const parsed: any[] = [];
  for (const line of allLines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      parsed.push({ msg: line });
    }
  }
  const level = opts.level?.toLowerCase();
  const q = opts.q?.toLowerCase();
  let filtered = parsed;
  if (level) filtered = filtered.filter((e) => String(e.level ?? e.lvl ?? "").toLowerCase() === level || String(e.level ?? "").toLowerCase().includes(level));
  if (q) filtered = filtered.filter((e) => JSON.stringify(e).toLowerCase().includes(q));
  const n = Math.max(1, Math.min(opts.lines ?? 200, 2000));
  const tail = filtered.slice(-n);
  return { file: selected, files: filesOut, lines: tail.map((e) => (typeof e === "string" ? e : JSON.stringify(e))), parsed: tail };
}

const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Service = require("node-windows").Service;

const root = path.resolve(__dirname, "..", "..");
const script = path.join(root, "dist", "server.js");
const configPath = process.env.DBHUB_CONFIG || "C:\\ProgramData\\DBHub\\config.json";

if (!require("node:fs").existsSync(script)) {
  console.error(`Missing build output: ${script}. Run npm run build first.`);
  process.exit(1);
}

const svc = new Service({
  name: "DBHub",
  description: "DBHub local sync service",
  script,
  workingDirectory: root,
  env: [
    { name: "NODE_ENV", value: "production" },
    { name: "DBHUB_CONFIG", value: configPath },
  ],
  nodeOptions: ["--max-old-space-size=512"],
  grow: 0.25,
  wait: 2,
  maxRestarts: 10,
});

svc.on("install", () => {
  console.log("Service installed. Starting...");
  svc.start();
});

svc.on("start", () => {
  try {
    execFileSync("sc.exe", [
      "failure",
      "DBHub",
      "reset=", "86400",
      "actions=", "restart/5000/restart/10000/restart/30000",
    ], { stdio: "inherit" });
  } catch (e) {
    console.error("Service started but failed to set recovery actions:", e.message);
  }
  console.log("DBHub installed and started.");
});

svc.on("error", (err) => {
  console.error("Service error:", err);
  process.exitCode = 1;
});

svc.install();

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const daemonDir = path.join(root, "dist", "daemon");
const serviceId = "dbhub.exe";
const fileBase = "dbhub";
const exePath = path.join(daemonDir, fileBase + ".exe");

function sleep(seconds) {
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", `Start-Sleep -Seconds ${seconds}`], {
      stdio: "ignore",
    });
  } catch {
    // Best effort only.
  }
}

function tryRun(command, args) {
  try {
    execFileSync(command, args, { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

console.log("Stopping service...");
tryRun("sc.exe", ["stop", serviceId]);
sleep(2);

if (fs.existsSync(exePath)) {
  console.log("Uninstalling service...");
  tryRun(exePath, ["uninstall"]);
  sleep(2);
}

console.log("Deleting service registration...");
tryRun("sc.exe", ["delete", serviceId]);
sleep(2);

const filesToRemove = [
  fileBase + ".xml",
  fileBase + ".exe",
  fileBase + ".exe.config",
  fileBase + ".wrapper.log",
  fileBase + ".out.log",
  fileBase + ".err.log",
];

for (const file of filesToRemove) {
  const fullPath = path.join(daemonDir, file);
  try {
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  } catch {
    // Best effort; the service registration is already removed.
  }
}

try {
  if (fs.existsSync(daemonDir) && fs.readdirSync(daemonDir).length === 0) {
    fs.rmdirSync(daemonDir);
  }
} catch {
  // Leave the directory in place if it cannot be removed.
}

console.log("DBHub uninstalled.");
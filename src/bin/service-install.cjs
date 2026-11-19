// WINDOWS-ONLY: service registration via sc.exe / winsw. Not used on Linux.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const script = path.join(root, "dist", "server.js");
const platformPaths = require(path.join(root, "src", "platform", "paths-impl.cjs"));
const configPath = process.env.DBHUB_CONFIG || platformPaths.defaultConfigPath();
const daemonDir = path.join(root, "dist", "daemon");
const serviceId = "dbhub.exe";
const fileBase = "dbhub";
const exePath = path.join(daemonDir, fileBase + ".exe");
const xmlPath = path.join(daemonDir, fileBase + ".xml");
const exeConfigPath = exePath + ".config";
const winswDir = path.join(root, "node_modules", "node-windows", "bin", "winsw");
const winswExe = path.join(winswDir, "winsw.exe");
const winswConfig = path.join(winswDir, "winsw.exe.config");
const wrapper = path.join(root, "node_modules", "node-windows", "lib", "wrapper.js");

function sleep(seconds) {
  execFileSync("powershell", ["-NoProfile", "-Command", `Start-Sleep -Seconds ${seconds}`], {
    stdio: "ignore",
  });
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: "inherit", ...options });
}

function tryRun(command, args, options = {}) {
  try {
    execFileSync(command, args, { stdio: "ignore", ...options });
    return true;
  } catch {
    return false;
  }
}

if (!fs.existsSync(script)) {
  console.error(`Missing build output: ${script}. Run npm run build first.`);
  process.exit(1);
}

fs.mkdirSync(daemonDir, { recursive: true });

// Remove a previous registration before rewriting the service files.
if (fs.existsSync(exePath)) {
  tryRun(exePath, ["uninstall"]);
}
tryRun("sc.exe", ["stop", serviceId]);
tryRun("sc.exe", ["delete", serviceId]);
sleep(2);

const winsw = require(path.join(root, "node_modules", "node-windows", "lib", "winsw"));
const xml = winsw.generateXml({
  id: serviceId,
  name: "DBHub",
  description: "DBHub local sync service",
  execPath: process.execPath,
  nodeOptions: ["--max-old-space-size=512"],
  script: wrapper,
  wrapperArgs: [
    "--file",
    script,
    "--scriptoptions=",
    "--log",
    "DBHub wrapper",
    "--grow",
    "0.25",
    "--wait",
    "2",
    "--maxrestarts",
    "10",
    "--abortonerror",
    "n",
    "--stopparentfirst",
    "undefined",
  ],
  env: [
    { name: "NODE_ENV", value: "production" },
    { name: "DBHUB_CONFIG", value: configPath },
  ],
  workingdirectory: root,
  logmode: "rotate",
  stoptimeout: 30,
});

fs.writeFileSync(xmlPath, xml);
fs.copyFileSync(winswExe, exePath);
fs.copyFileSync(winswConfig, exeConfigPath);

console.log("Installing service...");
run(exePath, ["install"]);
sleep(2);

console.log("Starting service...");
run("sc.exe", ["start", serviceId]);
run("sc.exe", ["config", serviceId, "start=", "auto"]);

console.log("Setting recovery actions...");
run("sc.exe", [
  "failure",
  serviceId,
  "reset=",
  "86400",
  "actions=",
  "restart/5000/restart/10000/restart/30000",
]);

console.log("DBHub installed and started.");
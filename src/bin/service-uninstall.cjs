const Service = require("node-windows").Service;

const svc = new Service({
  name: "DBHub",
  script: "",
});

svc.on("stop", () => {
  console.log("Service stopped. Uninstalling...");
  svc.uninstall();
});
svc.on("uninstall", () => {
  console.log("DBHub uninstalled.");
});
svc.on("error", (err) => {
  console.error("Service error:", err);
  process.exitCode = 1;
});

svc.stop();

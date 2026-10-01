#!/usr/bin/env node
const { execSync } = require("child_process");

const ports = [3001, 3002, 5173, 5174, 5175];

console.log("Checking ports:", ports.join(", "));

for (const port of ports) {
  try {
    const pids = execSync(
      `powershell -NoProfile -NonInteractive -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }
    )
      .trim()
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean);

    for (const pid of pids) {
      if (pid && !isNaN(Number(pid))) {
        execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
        console.log(`  Killed PID ${pid} on port ${port}`);
      }
    }
    if (pids.length === 0) {
      console.log(`  Port ${port} is free`);
    }
  } catch {
    console.log(`  Port ${port} is free`);
  }
}

console.log("\nAll ports cleared. You can now run the dev servers.");

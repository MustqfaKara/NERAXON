import { spawn } from "node:child_process";

const nextBin = new URL("../node_modules/next/dist/bin/next", import.meta.url);
let child = null;
let stopping = false;
let restartCount = 0;
let lastStartedAt = 0;

function start() {
  lastStartedAt = Date.now();
  child = spawn(process.execPath, [nextBin.pathname, "dev", "--hostname", "127.0.0.1"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  child.once("exit", (code, signal) => {
    child = null;
    if (stopping) process.exit(code ?? 0);
    if (Date.now() - lastStartedAt > 60_000) restartCount = 0;
    restartCount += 1;
    const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(5, restartCount - 1));
    console.error(`[NERAXON] Web süreci beklenmedik şekilde kapandı (${signal ?? code ?? "bilinmeyen"}). ${delayMs} ms sonra yeniden başlatılıyor.`);
    setTimeout(start, delayMs);
  });
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (child) child.kill(signal);
  else process.exit(0);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
start();

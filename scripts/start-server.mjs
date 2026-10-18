import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";
import { assertProductionRuntime } from "../lib/runtime-config.ts";

process.env.NODE_ENV = "production";
nextEnv.loadEnvConfig(process.cwd(), false);
try {
  assertProductionRuntime();
} catch (error) {
  // Error includes variable names and policy only, never secret values.
  console.error(error instanceof Error ? error.message : "Production configuration invalid");
  process.exit(1);
}

const nextCli = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const child = spawn(process.execPath, [nextCli, "start"], { stdio: "inherit", env: process.env });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(`Unable to start Next server: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});

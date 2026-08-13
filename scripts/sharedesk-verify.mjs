#!/usr/bin/env node

import { spawn } from "node:child_process";

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(commandName(command), args, {
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed${
            signal ? ` with signal ${signal}` : ` with exit code ${code}`
          }.`,
        ),
      );
    });
  });
}

for (const [command, args] of [
  ["npm", ["ci"]],
  ["npm", ["test"]],
  ["npm", ["run", "lint"]],
  ["npx", ["--no-install", "tsc", "--noEmit"]],
  ["npm", ["run", "build"]],
]) {
  await run(command, args);
}

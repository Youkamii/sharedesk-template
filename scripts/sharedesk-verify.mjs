#!/usr/bin/env node

import { spawn } from "node:child_process";

function commandInvocation(command, args) {
  if (process.platform === "win32") {
    return [
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", `${command}.cmd`, ...args],
    ];
  }
  return [command, args];
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const [executable, executableArgs] = commandInvocation(command, args);
    const child = spawn(executable, executableArgs, {
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

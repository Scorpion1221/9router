#!/usr/bin/env node
import { VERSION } from "../src/version.js";

const argv = process.argv.slice(2);
if (argv.length === 1 && ["-v", "-V", "--version"].includes(argv[0])) {
  process.stdout.write(`${VERSION}\n`);
} else {
  const { main } = await import("../src/cli.js");
  process.exitCode = await main(argv);
}

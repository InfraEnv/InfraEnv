#!/usr/bin/env node
import { createProgram } from "./program.js";

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  console.error(`infraenv: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

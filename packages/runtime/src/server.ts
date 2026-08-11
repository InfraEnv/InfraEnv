#!/usr/bin/env node
import { resolve } from "node:path";
import { createRuntime } from "./app.js";

const port = Number.parseInt(process.env.INFRAENV_PORT ?? "8080", 10);
const host = process.env.INFRAENV_HOST ?? "0.0.0.0";
const staticRoot = process.env.INFRAENV_UI_ROOT ? resolve(process.env.INFRAENV_UI_ROOT) : undefined;
const tokens = process.env.INFRAENV_HOST_TOKEN && process.env.INFRAENV_SANDBOX_TOKEN && process.env.INFRAENV_UI_LAUNCH_TOKEN
  ? {
      hostToken: process.env.INFRAENV_HOST_TOKEN,
      sandboxToken: process.env.INFRAENV_SANDBOX_TOKEN,
      uiLaunchToken: process.env.INFRAENV_UI_LAUNCH_TOKEN
    }
  : undefined;

const runtime = await createRuntime({
  logger: true,
  ...(staticRoot ? { staticRoot } : {}),
  ...(tokens ? { tokens } : {}),
  ...(process.env.INFRAENV_PROGRESS_FILE ? { progressFile: process.env.INFRAENV_PROGRESS_FILE } : {}),
  ...(process.env.INFRAENV_CURRICULUM_CHECKSUM ? { curriculumChecksum: process.env.INFRAENV_CURRICULUM_CHECKSUM } : {}),
  ...(process.env.INFRAENV_SESSION_ID ? { sessionId: process.env.INFRAENV_SESSION_ID } : {})
});

await runtime.app.listen({ port, host });

const shutdown = async (): Promise<void> => {
  runtime.context.engine.stop();
  await runtime.context.progress.append("session.stopped", { reason: "signal" });
  await runtime.app.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

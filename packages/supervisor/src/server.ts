import { startSupervisor } from "./app.js";

const port = Number(process.env.INFRAENV_SUPERVISOR_PORT ?? 7331);
const host = process.env.INFRAENV_SUPERVISOR_HOST ?? "127.0.0.1";
const running = await startSupervisor({ host, port, logger: true });

console.log(`InfraEnv Supervisor listening at ${running.address}`);
console.log(`Bearer token: ${running.token}`);

const close = async () => {
  await running.close();
  process.exit(0);
};
process.once("SIGINT", close);
process.once("SIGTERM", close);

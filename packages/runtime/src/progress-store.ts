import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { RUNTIME_VERSION, type LearningRecord } from "@infraenv/shared";

export interface ProgressStoreOptions {
  filePath: string;
  sessionId: string;
  scenarioId: string;
  scenarioVersion: string;
  curriculumChecksum: string;
  contentVersion: string;
}

export class ProgressStore {
  constructor(private readonly options: ProgressStoreOptions) {}

  async append(event: LearningRecord["event"], payload: Record<string, unknown>): Promise<void> {
    const record: LearningRecord = {
      recordedAt: new Date().toISOString(),
      sessionId: this.options.sessionId,
      contentVersion: this.options.contentVersion,
      runtimeVersion: RUNTIME_VERSION,
      scenarioId: this.options.scenarioId,
      scenarioVersion: this.options.scenarioVersion,
      curriculumChecksum: this.options.curriculumChecksum,
      event,
      payload
    };
    await mkdir(dirname(this.options.filePath), { recursive: true });
    await appendFile(this.options.filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

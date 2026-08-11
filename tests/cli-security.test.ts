import { describe, expect, it } from "vitest";
import { interactiveDockerArguments, renderDoctor, securityArguments, type DockerProbe } from "@infraenv/cli";

describe("CLI safety posture", () => {
  it("does not substitute MinGW when Docker is unavailable", () => {
    const probe: DockerProbe = { available: false, reason: "daemon unavailable" };
    const result = renderDoctor(probe);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("will not fall back to MinGW");
    expect(result.text).toContain("Start Docker Desktop");
  });

  it("rejects Docker versions older than the lab requirement", () => {
    const result = renderDoctor({ available: true, version: "25.0.5", osType: "linux", imagesReady: true });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("requires >=26");
    expect(result.text).toContain("too old");
  });

  it("uses read-only non-privileged container flags without broad mounts", () => {
    const args = [...securityArguments("runtime"), ...securityArguments("sandbox")].join(" ");
    expect(args).toContain("--read-only");
    expect(args).toContain("no-new-privileges:true");
    expect(args).toContain("--cap-drop ALL");
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("docker.sock");
    expect(args).not.toContain("type=bind");
  });

  it("does not request a TTY in automation", () => {
    expect(interactiveDockerArguments(false, false)).toEqual(["-i"]);
    expect(interactiveDockerArguments(true, true)).toEqual(["-it"]);
  });
});

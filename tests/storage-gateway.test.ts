import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LocalFilesystemBackend,
  MemoryS3Backend,
  S3CompatibleHttpBackend,
  StorageGateway,
  UnsignedS3SigningProvider,
  validateS3Endpoint,
  validateStorageKey
} from "@infraenv/storage-gateway";

describe("storage gateway policy", () => {
  it.each(["", "/absolute", "../escape", "a/../b", "a\\b", "a//b"])("rejects unsafe key %j", (key) => {
    expect(() => validateStorageKey(key)).toThrow();
  });

  it("supports symbolic metadata without materializing the object", async () => {
    const gateway = new StorageGateway(new MemoryS3Backend(), { namespace: "environments", maxObjectBytes: 1024, allowedContentTypes: ["application/json"] });
    await gateway.putJson("environment/demo.json", { id: "environment:demo" });
    const symbolic = await gateway.load("environment/demo.json", { materialize: false });
    expect(symbolic).toMatchObject({ materialized: false, backendKind: "s3-simulated" });
    expect(symbolic).not.toHaveProperty("body");
  });

  it("writes local objects atomically under the configured root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "infraenv-storage-"));
    const gateway = new StorageGateway(new LocalFilesystemBackend(directory), { namespace: "registry", maxObjectBytes: 1024, allowedContentTypes: ["application/json"] });
    await gateway.putJson("index.json", { revision: 1 });
    expect(JSON.parse(await readFile(join(directory, "registry", "index.json"), "utf8"))).toEqual({ revision: 1 });
  });
});

describe("S3-compatible endpoint boundary", () => {
  it("requires TLS and rejects local, private, metadata, and credential-bearing endpoints by default", () => {
    for (const endpoint of ["http://s3.example.com", "https://localhost", "https://127.0.0.1", "https://169.254.169.254", "https://metadata.google.internal", "https://user:pass@s3.example.com"]) {
      expect(() => validateS3Endpoint(endpoint), endpoint).toThrow();
    }
    expect(validateS3Endpoint("https://s3.example.com").hostname).toBe("s3.example.com");
    expect(validateS3Endpoint("http://127.0.0.1:9000", { allowInsecureHttp: true, allowPrivateEndpoint: true }).port).toBe("9000");
  });

  it("keeps real S3 distinct from MemoryS3 and enforces read-only descriptors", async () => {
    const backend = new S3CompatibleHttpBackend({ endpoint: "https://s3.example.com", bucket: "infraenv-demo", prefix: "safe", readOnly: true, maxDownloadBytes: 1024 }, new UnsignedS3SigningProvider());
    expect(backend.kind).toBe("s3-compatible-http");
    expect(new MemoryS3Backend().kind).toBe("s3-simulated");
    await expect(backend.put({ key: "x", body: new Uint8Array([1]), etag: "x", size: 1, updatedAt: new Date(0).toISOString(), contentType: "application/octet-stream" })).rejects.toThrow("read-only");
  });
});

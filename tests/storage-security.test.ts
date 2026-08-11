import { describe, expect, it, vi } from "vitest";
import {
  MemoryS3Backend,
  S3CompatibleHttpBackend,
  type S3CompatibleDescriptor,
  type S3DnsResolver,
  type S3Fetch,
  type S3SigningProvider,
  type StorageObject,
  validateS3Endpoint
} from "@infraenv/storage-gateway";

const publicResolver: S3DnsResolver = async () => [{ address: "203.0.113.10", family: 4 }];
const okFetch: S3Fetch = async () => new Response(null, { status: 200 });

function descriptor(overrides: Partial<S3CompatibleDescriptor> = {}): S3CompatibleDescriptor {
  return {
    endpoint: "https://s3.example.test",
    bucket: "infraenv-demo",
    prefix: "tenant-a",
    maxDownloadBytes: 1024,
    ...overrides
  };
}

function object(key: string): StorageObject {
  const body = new Uint8Array([1, 2, 3]);
  return { key, body, etag: "fixture", size: body.byteLength, updatedAt: new Date(0).toISOString(), contentType: "application/octet-stream" };
}

const unsignedSigner: S3SigningProvider = { kind: "test-unsigned", async sign() { return {}; } };

describe("S3 request DNS and endpoint boundary", () => {
  it("resolves every request and rejects any private answer before signing or fetching", async () => {
    const resolver = vi.fn<S3DnsResolver>()
      .mockResolvedValueOnce([{ address: "203.0.113.10", family: 4 }])
      .mockResolvedValueOnce([{ address: "203.0.113.10", family: 4 }, { address: "10.0.0.8", family: 4 }]);
    const fetch = vi.fn<S3Fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    const signer = { kind: "test", sign: vi.fn(async () => ({})) } satisfies S3SigningProvider;
    const backend = new S3CompatibleHttpBackend(descriptor(), signer, { resolver, fetch });

    await expect(backend.get("models/a.bin")).resolves.toBeUndefined();
    await expect(backend.get("models/b.bin")).rejects.toThrow(/private address 10\.0\.0\.8/i);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(signer.sign).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[2]?.resolvedAddresses).toEqual([{ address: "203.0.113.10", family: 4 }]);
  });

  it("always rejects metadata and link-local answers, including in explicit local mode", async () => {
    const backend = new S3CompatibleHttpBackend(
      descriptor({ endpoint: "http://minio.local:9000", allowInsecureHttp: true, allowPrivateEndpoint: true }),
      unsignedSigner,
      { resolver: async () => [{ address: "169.254.169.254", family: 4 }], fetch: okFetch }
    );
    await expect(backend.get("models/a.bin")).rejects.toThrow(/metadata/i);
    expect(() => validateS3Endpoint("https://169.254.169.254", { allowInsecureHttp: true, allowPrivateEndpoint: true })).toThrow(/never allowed/i);
  });

  it.each([
    ["127.0.0.2", 4],
    ["10.12.0.4", 4],
    ["172.20.0.4", 4],
    ["192.168.1.4", 4],
    ["169.254.1.2", 4],
    ["fc00::12", 6],
    ["fe80::12", 6]
  ] as const)("rejects resolved local/private address %s by default", async (address, family) => {
    const fetch = vi.fn<S3Fetch>();
    const backend = new S3CompatibleHttpBackend(descriptor(), unsignedSigner, { resolver: async () => [{ address, family }], fetch });
    await expect(backend.get("models/a.bin")).rejects.toThrow(/private|loopback|link-local/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires both local/private and insecure switches for a local MinIO endpoint", async () => {
    expect(() => validateS3Endpoint("http://127.0.0.1:9000", { allowInsecureHttp: true })).toThrow(/both/i);
    expect(() => validateS3Endpoint("http://127.0.0.1:9000", { allowPrivateEndpoint: true })).toThrow(/TLS/i);
    const backend = new S3CompatibleHttpBackend(
      descriptor({ endpoint: "http://127.0.0.1:9000", allowInsecureHttp: true, allowPrivateEndpoint: true }),
      unsignedSigner,
      { resolver: async () => { throw new Error("IP literals must not perform DNS lookup"); }, fetch: async () => new Response(null, { status: 404 }) }
    );
    await expect(backend.get("models/a.bin")).resolves.toBeUndefined();
    expect(() => validateS3Endpoint("http://[::1]:9000", { allowInsecureHttp: true })).toThrow(/both/i);
    expect(() => validateS3Endpoint("http://[::1]:9000", { allowInsecureHttp: true, allowPrivateEndpoint: true })).not.toThrow();
  });

  it("rejects reserved and IPv4-mapped IPv6 answers even in local mode", async () => {
    for (const address of ["0.0.0.0", "::ffff:127.0.0.1"]) {
      const backend = new S3CompatibleHttpBackend(
        descriptor({ endpoint: "http://minio.local:9000", allowInsecureHttp: true, allowPrivateEndpoint: true }),
        unsignedSigner,
        { resolver: async () => [{ address, family: address.includes(":") ? 6 : 4 } as const], fetch: okFetch }
      );
      await expect(backend.get("models/a.bin"), address).rejects.toThrow(/forbidden/i);
    }
  });

  it("refuses redirects even when a transport returns one", async () => {
    const fetch = vi.fn<S3Fetch>().mockResolvedValue(new Response(null, { status: 307, headers: { location: "https://evil.example/" } }));
    const backend = new S3CompatibleHttpBackend(descriptor(), unsignedSigner, { resolver: publicResolver, fetch });
    await expect(backend.get("models/a.bin")).rejects.toThrow(/redirects are refused/i);
    expect(fetch.mock.calls[0]?.[1].redirect).toBe("error");
  });
});

describe("S3 bucket, prefix, and operation isolation", () => {
  it("defaults to read-only and requires independent PUT and DELETE prefix grants", async () => {
    const readonly = new S3CompatibleHttpBackend(descriptor(), unsignedSigner, { resolver: publicResolver, fetch: okFetch });
    await expect(readonly.put(object("models/a.bin"))).rejects.toThrow(/read-only by default/i);

    const fetch = vi.fn<S3Fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const writable = new S3CompatibleHttpBackend(
      descriptor({ readOnly: false, writePrefixes: ["models"], deletePrefixes: ["trash"] }),
      unsignedSigner,
      { resolver: publicResolver, fetch }
    );
    await expect(writable.put(object("models/a.bin"))).resolves.toBeUndefined();
    await expect(writable.put(object("models-escape/a.bin"))).rejects.toThrow(/write is not authorized/i);
    await expect(writable.put(object("private/a.bin"))).rejects.toThrow(/write is not authorized/i);
    await expect(writable.delete("models/a.bin")).rejects.toThrow(/delete is not authorized/i);
    await expect(writable.delete("trash/a.bin")).resolves.toBe(true);
    expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(["PUT", "DELETE"]);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/infraenv-demo/tenant-a/models/a.bin");
  });

  it("filters LIST results to the configured bucket/prefix and strips only that prefix", async () => {
    const xml = `<?xml version="1.0"?><ListBucketResult>
      <Contents><Key>tenant-a/models/a.bin</Key><Size>3</Size><ETag>"a"</ETag><LastModified>2026-01-01T00:00:00Z</LastModified></Contents>
      <Contents><Key>tenant-b/models/secret.bin</Key><Size>9</Size></Contents>
      <Contents><Key>tenant-a/../escape.bin</Key><Size>1</Size></Contents>
    </ListBucketResult>`;
    const fetch = vi.fn<S3Fetch>().mockResolvedValue(new Response(xml, { status: 200, headers: { "content-type": "application/xml" } }));
    const backend = new S3CompatibleHttpBackend(descriptor(), unsignedSigner, { resolver: publicResolver, fetch });

    await expect(backend.list("models")).resolves.toEqual([
      { key: "models/a.bin", size: 3, etag: "a", updatedAt: "2026-01-01T00:00:00.000Z", contentType: "application/octet-stream" }
    ]);
    const requested = fetch.mock.calls[0]?.[0];
    expect(requested?.pathname).toBe("/infraenv-demo");
    expect(requested?.searchParams.get("prefix")).toBe("tenant-a/models");
    await expect(backend.get("../escape")).rejects.toThrow(/unsafe storage key/i);
  });
});

describe("S3 quota, timeout, and credential handling", () => {
  it("enforces advertised and streamed download limits", async () => {
    const advertised = new S3CompatibleHttpBackend(descriptor({ maxDownloadBytes: 3 }), unsignedSigner, {
      resolver: publicResolver,
      fetch: async () => new Response(new Uint8Array([1]), { status: 200, headers: { "content-length": "4" } })
    });
    await expect(advertised.get("models/a.bin")).rejects.toThrow(/advertises 4 bytes/i);

    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4])); controller.close(); } });
    const streamed = new S3CompatibleHttpBackend(descriptor({ maxDownloadBytes: 3 }), unsignedSigner, {
      resolver: publicResolver,
      fetch: async () => new Response(stream, { status: 200 })
    });
    await expect(streamed.get("models/a.bin")).rejects.toThrow(/exceeded the 3 byte/i);
  });

  it("times out a transport that ignores its AbortSignal", async () => {
    const never: S3Fetch = async () => new Promise<Response>(() => undefined);
    const backend = new S3CompatibleHttpBackend(descriptor({ requestTimeoutMs: 10 }), unsignedSigner, { resolver: publicResolver, fetch: never });
    await expect(backend.get("models/a.bin")).rejects.toThrow(/timed out after 10 ms/i);
  });

  it("keeps the same timeout active while streaming the response body", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); } });
    const backend = new S3CompatibleHttpBackend(descriptor({ requestTimeoutMs: 10 }), unsignedSigner, {
      resolver: publicResolver,
      fetch: async () => new Response(stream, { status: 200 })
    });
    await expect(backend.get("models/a.bin")).rejects.toThrow(/timed out after 10 ms/i);
  });

  it("keeps credentials behind a non-serializable signer boundary", async () => {
    const signer = {
      kind: "credential-store",
      secret: "must-not-serialize",
      async sign() { return { authorization: "signed-but-never-logged" }; }
    } satisfies S3SigningProvider & { secret: string };
    const backend = new S3CompatibleHttpBackend(descriptor(), signer, { resolver: publicResolver, fetch: async () => new Response(null, { status: 404 }) });
    expect(JSON.stringify(backend)).not.toContain("must-not-serialize");
    await expect(backend.get("models/a.bin")).resolves.toBeUndefined();
    expect(() => new S3CompatibleHttpBackend({ ...descriptor(), credentials: { secret: "x" } } as unknown as S3CompatibleDescriptor, signer)).toThrow(/signer interface/i);
  });

  it("does not let a signer override request-boundary headers", async () => {
    const signer: S3SigningProvider = { kind: "bad-signer", async sign() { return { Host: "metadata.google.internal" }; } };
    const fetch = vi.fn<S3Fetch>();
    const backend = new S3CompatibleHttpBackend(descriptor(), signer, { resolver: publicResolver, fetch });
    await expect(backend.get("models/a.bin")).rejects.toThrow(/protected header Host/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("redacts signer failures instead of leaking credential-provider details", async () => {
    const signer: S3SigningProvider = { kind: "credential-store", async sign() { throw new Error("secret-value-from-provider"); } };
    const backend = new S3CompatibleHttpBackend(descriptor(), signer, { resolver: publicResolver, fetch: okFetch });
    const error = await backend.get("models/a.bin").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/signing failed.*redacted/i);
    expect((error as Error).message).not.toContain("secret-value-from-provider");
  });

  it("retains an explicit simulated/external backend distinction", () => {
    expect(new MemoryS3Backend().kind).toBe("s3-simulated");
    expect(new S3CompatibleHttpBackend(descriptor(), unsignedSigner).kind).toBe("s3-compatible-http");
  });
});

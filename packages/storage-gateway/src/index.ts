import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type RequestOptions as HttpRequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { dirname, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";

export interface StorageObject {
  key: string;
  body: Uint8Array;
  etag: string;
  size: number;
  updatedAt: string;
  contentType: string;
}

export type StorageObjectMetadata = Omit<StorageObject, "body">;

function storageMetadata(object: StorageObject): StorageObjectMetadata {
  return { key: object.key, etag: object.etag, size: object.size, updatedAt: object.updatedAt, contentType: object.contentType };
}

export interface StorageBackend {
  readonly kind: string;
  put(object: StorageObject): Promise<void>;
  get(key: string): Promise<StorageObject | undefined>;
  delete(key: string): Promise<boolean>;
  list(prefix: string): Promise<StorageObjectMetadata[]>;
}

export interface SymbolicStorageObject extends StorageObjectMetadata {
  materialized: false;
  backendKind: string;
}

export type StorageLoadResult = StorageObject | SymbolicStorageObject;

export interface GatewaySecurityPolicy {
  namespace: string;
  maxObjectBytes: number;
  allowedContentTypes: string[];
  readOnly?: boolean;
}

export interface PutResult { key: string; etag: string; size: number; updatedAt: string }

export function validateStorageKey(key: string): string {
  if (!key || key.length > 512 || key.includes("\0") || key.includes("\\") || key.startsWith("/") || key.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe storage key: ${JSON.stringify(key)}.`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(key)) throw new Error(`Storage key contains unsupported characters: ${key}.`);
  return key;
}

export class StorageGateway {
  constructor(readonly backend: StorageBackend, readonly policy: GatewaySecurityPolicy) {
    validateStorageKey(policy.namespace);
    if (policy.maxObjectBytes <= 0) throw new Error("maxObjectBytes must be positive.");
  }

  private scoped(key: string): string { return `${this.policy.namespace}/${validateStorageKey(key)}`; }

  async put(key: string, body: Uint8Array, contentType = "application/octet-stream"): Promise<PutResult> {
    if (this.policy.readOnly) throw new Error("Storage gateway is read-only.");
    if (body.byteLength > this.policy.maxObjectBytes) throw new Error(`Object exceeds ${this.policy.maxObjectBytes} byte policy limit.`);
    if (!this.policy.allowedContentTypes.includes(contentType)) throw new Error(`Content type ${contentType} is not allowed.`);
    const object: StorageObject = { key: this.scoped(key), body: new Uint8Array(body), etag: createHash("sha256").update(body).digest("hex"), size: body.byteLength, updatedAt: new Date().toISOString(), contentType };
    await this.backend.put(object);
    return { key, etag: object.etag, size: object.size, updatedAt: object.updatedAt };
  }

  async putJson(key: string, value: unknown): Promise<PutResult> {
    return this.put(key, new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`), "application/json");
  }

  async get(key: string): Promise<StorageObject | undefined> { return this.backend.get(this.scoped(key)); }
  async load(key: string, options: { materialize?: boolean } = {}): Promise<StorageLoadResult | undefined> {
    if (options.materialize !== false) return this.get(key);
    const scopedKey = this.scoped(key);
    const metadata = (await this.backend.list(scopedKey)).find((candidate) => candidate.key === scopedKey);
    return metadata ? { ...metadata, materialized: false, backendKind: this.backend.kind } : undefined;
  }
  async getJson<T>(key: string): Promise<T | undefined> { const object = await this.get(key); return object ? JSON.parse(new TextDecoder().decode(object.body)) as T : undefined; }
  async delete(key: string): Promise<boolean> { if (this.policy.readOnly) throw new Error("Storage gateway is read-only."); return this.backend.delete(this.scoped(key)); }
  async list(prefix = "index"): Promise<StorageObjectMetadata[]> { return this.backend.list(this.scoped(prefix)); }
}

export class MemoryS3Backend implements StorageBackend {
  readonly kind = "s3-simulated";
  private readonly objects = new Map<string, StorageObject>();
  constructor(readonly bucket = "infraenv-local-s3") {}
  async put(object: StorageObject): Promise<void> { this.objects.set(object.key, { ...object, body: new Uint8Array(object.body) }); }
  async get(key: string): Promise<StorageObject | undefined> { const value = this.objects.get(key); return value ? { ...value, body: new Uint8Array(value.body) } : undefined; }
  async delete(key: string): Promise<boolean> { return this.objects.delete(key); }
  async list(prefix: string): Promise<StorageObjectMetadata[]> { return [...this.objects.values()].filter((value) => value.key.startsWith(prefix)).map(storageMetadata).sort((a, b) => a.key.localeCompare(b.key)); }
}

export class LocalFilesystemBackend implements StorageBackend {
  readonly kind = "local-filesystem";
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  private pathFor(key: string): string {
    const path = resolve(this.root, ...validateStorageKey(key).split("/"));
    const relation = relative(this.root, path);
    if (relation.startsWith("..") || relation.includes(`..${sep}`)) throw new Error("Storage path escaped the configured root.");
    return path;
  }

  async put(object: StorageObject): Promise<void> {
    const path = this.pathFor(object.key); const metaPath = `${path}.meta.json`; const temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, object.body, { mode: 0o600 }); await rename(temporary, path);
    await writeFile(metaPath, `${JSON.stringify({ etag: object.etag, size: object.size, updatedAt: object.updatedAt, contentType: object.contentType })}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async get(key: string): Promise<StorageObject | undefined> {
    const path = this.pathFor(key);
    try {
      const [body, meta] = await Promise.all([readFile(path), readFile(`${path}.meta.json`, "utf8").then((value) => JSON.parse(value) as Omit<StorageObject, "key" | "body">)]);
      return { key, body, ...meta };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<boolean> {
    const path = this.pathFor(key);
    const existed = Boolean(await this.get(key));
    await Promise.all([rm(path, { force: true }), rm(`${path}.meta.json`, { force: true })]);
    return existed;
  }

  async list(prefix: string): Promise<StorageObjectMetadata[]> {
    const base = this.pathFor(prefix); const output: StorageObjectMetadata[] = [];
    const walk = async (directory: string): Promise<void> => {
      let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (!entry.name.endsWith(".meta.json") && !entry.name.endsWith(".tmp")) {
          const key = relative(this.root, path).split(sep).join("/"); const object = await this.get(key); if (object) output.push(storageMetadata(object));
        }
      }
    };
    await walk(base); return output.sort((a, b) => a.key.localeCompare(b.key));
  }
}

export interface S3EndpointPolicy {
  /** Explicitly permits HTTP. It never permits a local/private target by itself. */
  allowInsecureHttp?: boolean;
  /** Local/private endpoints additionally require allowInsecureHttp=true. */
  allowPrivateEndpoint?: boolean;
}

export interface S3CompatibleDescriptor extends S3EndpointPolicy {
  endpoint: string;
  bucket: string;
  prefix?: string;
  region?: string;
  pathStyle?: boolean;
  /** Defaults to true. Setting false still requires operation-specific prefixes. */
  readOnly?: boolean;
  /** Logical key prefixes authorized for PUT. Does not authorize DELETE. */
  writePrefixes?: string[];
  /** Logical key prefixes authorized for DELETE. Does not authorize PUT. */
  deletePrefixes?: string[];
  maxDownloadBytes: number;
  requestTimeoutMs?: number;
}

export interface S3ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type S3DnsResolver = (hostname: string) => Promise<readonly S3ResolvedAddress[]>;
export interface S3NetworkContext {
  /** Every address was checked before the transport is invoked. */
  resolvedAddresses: readonly S3ResolvedAddress[];
}
export type S3Fetch = (input: URL, init: RequestInit, context?: S3NetworkContext) => Promise<Response>;

export interface S3BackendDependencies {
  /** Injectable so security tests never need real DNS. */
  resolver?: S3DnsResolver;
  /**
   * Injectable for tests or a stricter embedder. A custom transport must connect
   * only to context.resolvedAddresses and must not perform an independent lookup.
   */
  fetch?: S3Fetch;
}

export interface S3SigningInput {
  method: "GET" | "PUT" | "DELETE";
  url: URL;
  headers: Readonly<Record<string, string>>;
  bodySha256: string;
  region: string;
  service: "s3";
}

/** Credentials remain owned by the host credential provider and are never serialized by InfraEnv. */
export interface S3SigningProvider {
  readonly kind: string;
  sign(input: S3SigningInput): Promise<Record<string, string>>;
}

/** Only appropriate for explicitly public, normally read-only buckets. */
export class UnsignedS3SigningProvider implements S3SigningProvider {
  readonly kind = "unsigned-public";
  async sign(): Promise<Record<string, string>> { return {}; }
}

const metadataHostnames = new Set(["metadata", "metadata.google.internal", "instance-data"]);
const metadataAddresses = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200", "fd00:ec2::254"]);

type AddressScope = "public" | "loopback" | "private" | "link-local" | "reserved" | "metadata" | "mapped";

function ipv4Scope(address: string): AddressScope {
  if (metadataAddresses.has(address)) return "metadata";
  const [a = 0, b = 0] = address.split(".").map(Number);
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "private";
  if (a === 0 || a >= 224) return "reserved";
  return "public";
}

function ipv6Scope(address: string): AddressScope {
  const normalized = address.replace(/^\[|\]$/g, "").split("%")[0]!.toLowerCase();
  if (metadataAddresses.has(normalized)) return "metadata";
  if (normalized.startsWith("::ffff:")) return "mapped";
  if (normalized === "::1") return "loopback";
  if (normalized === "::") return "reserved";
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return "link-local";
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return "private";
  if (normalized.startsWith("ff")) return "reserved";
  return "public";
}

function addressScope(address: string): AddressScope {
  const normalized = address.replace(/^\[|\]$/g, "").split("%")[0]!;
  const family = isIP(normalized);
  if (family === 4) return ipv4Scope(normalized);
  if (family === 6) return ipv6Scope(normalized);
  throw new Error(`DNS resolver returned an invalid address: ${address}.`);
}

function explicitLocalMode(policy: S3EndpointPolicy): boolean {
  return policy.allowInsecureHttp === true && policy.allowPrivateEndpoint === true;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}

export function validateS3Endpoint(endpoint: string, policy: S3EndpointPolicy = {}): URL {
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new Error("S3 endpoint must be an absolute HTTP(S) URL."); }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && policy.allowInsecureHttp)) throw new Error("S3 endpoint must use TLS; HTTP requires allowInsecureHttp=true.");
  if (parsed.username || parsed.password) throw new Error("S3 endpoint URL must not contain credentials.");
  if (parsed.search || parsed.hash) throw new Error("S3 endpoint URL must not contain query parameters or a fragment.");
  const hostname = normalizeHostname(parsed.hostname);
  if (metadataHostnames.has(hostname) || metadataAddresses.has(hostname)) throw new Error(`S3 endpoint ${hostname} is a cloud metadata target and is never allowed.`);
  const directScope = isIP(hostname) ? addressScope(hostname) : undefined;
  if (directScope === "metadata" || directScope === "link-local" || directScope === "reserved" || directScope === "mapped") throw new Error(`S3 endpoint ${hostname} is ${directScope} and is never allowed.`);
  const localName = hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local");
  const localAddress = directScope !== undefined && directScope !== "public";
  if ((localName || localAddress) && !explicitLocalMode(policy)) {
    throw new Error(`Local/private S3 endpoint ${hostname} requires both allowPrivateEndpoint=true and allowInsecureHttp=true.`);
  }
  return parsed;
}

function validateBucket(bucket: string): string {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) throw new Error(`Invalid S3 bucket name: ${bucket}.`);
  return bucket;
}

function xmlDecode(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}

function xmlValue(xml: string, name: string): string | undefined {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match?.[1] === undefined ? undefined : xmlDecode(match[1]);
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("S3 request aborted.");
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = () => rejectPromise(signal.reason instanceof Error ? signal.reason : new Error("S3 request aborted."));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolvePromise(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); rejectPromise(error); }
    );
  });
}

async function boundedBody(response: Response, maximumBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const lengthHeader = response.headers.get("content-length");
  const advertised = lengthHeader === null ? 0 : Number(lengthHeader);
  if (!Number.isSafeInteger(advertised) || advertised < 0) {
    await response.body?.cancel("invalid content length").catch(() => undefined);
    throw new Error("S3 object returned an invalid Content-Length header.");
  }
  if (advertised > maximumBytes) {
    await response.body?.cancel("maximum object size exceeded").catch(() => undefined);
    throw new Error(`S3 object advertises ${advertised} bytes, above the ${maximumBytes} byte limit.`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await abortable(reader.read(), signal);
    } catch (error) {
      await reader.cancel("request aborted").catch(() => undefined);
      throw error;
    }
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel("maximum object size exceeded");
      throw new Error(`S3 object exceeded the ${maximumBytes} byte download limit.`);
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

/**
 * A real S3-compatible HTTP transport with a pluggable host credential signer.
 * Redirects are refused to keep the validated endpoint boundary intact.
 */
export class S3CompatibleHttpBackend implements StorageBackend {
  readonly kind = "s3-compatible-http";
  readonly descriptor: Readonly<S3CompatibleDescriptor>;
  readonly endpoint: URL;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly readOnly: boolean;
  private readonly writePrefixes: readonly string[];
  private readonly deletePrefixes: readonly string[];
  readonly #signer: S3SigningProvider;
  readonly #resolver: S3DnsResolver;
  readonly #fetch: S3Fetch;

  constructor(descriptor: S3CompatibleDescriptor, signer: S3SigningProvider, dependencies: S3BackendDependencies = {}) {
    for (const field of Object.keys(descriptor)) {
      if (/(?:credential|secret|access.?key|session.?token|authorization)/i.test(field)) throw new Error(`S3 credentials must be supplied only through the signer interface; descriptor field ${field} is forbidden.`);
    }
    this.endpoint = validateS3Endpoint(descriptor.endpoint, descriptor);
    this.bucket = validateBucket(descriptor.bucket);
    this.prefix = descriptor.prefix ? validateStorageKey(descriptor.prefix) : "";
    this.readOnly = descriptor.readOnly !== false;
    this.writePrefixes = validateAuthorizationPrefixes(descriptor.writePrefixes, "writePrefixes");
    this.deletePrefixes = validateAuthorizationPrefixes(descriptor.deletePrefixes, "deletePrefixes");
    this.descriptor = Object.freeze({
      ...descriptor,
      ...(descriptor.writePrefixes === undefined ? {} : { writePrefixes: Object.freeze([...this.writePrefixes]) as string[] }),
      ...(descriptor.deletePrefixes === undefined ? {} : { deletePrefixes: Object.freeze([...this.deletePrefixes]) as string[] })
    });
    this.#signer = signer;
    this.#resolver = dependencies.resolver ?? defaultResolver;
    this.#fetch = dependencies.fetch ?? pinnedHttpFetch;
    if (!Number.isSafeInteger(descriptor.maxDownloadBytes) || descriptor.maxDownloadBytes <= 0) throw new Error("maxDownloadBytes must be a positive safe integer.");
    if (descriptor.requestTimeoutMs !== undefined && (!Number.isSafeInteger(descriptor.requestTimeoutMs) || descriptor.requestTimeoutMs <= 0)) throw new Error("requestTimeoutMs must be a positive safe integer.");
  }

  private objectKey(key: string): string { return this.prefix ? `${this.prefix}/${validateStorageKey(key)}` : validateStorageKey(key); }

  private objectUrl(key: string): URL {
    const objectKey = this.objectKey(key).split("/").map(encodeURIComponent).join("/");
    const url = new URL(this.endpoint);
    const endpointPath = url.pathname.replace(/\/$/, "");
    if (this.descriptor.pathStyle !== false) url.pathname = `${endpointPath}/${encodeURIComponent(this.bucket)}/${objectKey}`;
    else { url.hostname = `${this.bucket}.${url.hostname}`; url.pathname = `${endpointPath}/${objectKey}`; }
    return url;
  }

  private assertAuthorized(operation: "write" | "delete", key: string): void {
    if (this.readOnly) throw new Error("S3 backend is read-only by default; set readOnly=false and authorize an operation prefix explicitly.");
    const prefixes = operation === "write" ? this.writePrefixes : this.deletePrefixes;
    const logicalKey = validateStorageKey(key);
    if (!prefixes.some((prefix) => logicalKey === prefix || logicalKey.startsWith(`${prefix}/`))) {
      throw new Error(`S3 ${operation} is not authorized for key ${logicalKey}; configure an explicit ${operation === "write" ? "writePrefixes" : "deletePrefixes"} entry.`);
    }
  }

  private async request(method: S3SigningInput["method"], url: URL, body?: Uint8Array, extraHeaders: Record<string, string> = {}): Promise<SecuredResponse> {
    const timeoutMs = this.descriptor.requestTimeoutMs ?? 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`S3 request timed out after ${timeoutMs} ms.`)), timeoutMs);
    const bodySha256 = createHash("sha256").update(body ?? new Uint8Array()).digest("hex");
    const baseHeaders = Object.freeze({ host: url.host, "x-amz-content-sha256": bodySha256, ...extraHeaders });
    try {
      const resolvedAddresses = await abortable(this.resolveAndValidate(url), controller.signal);
      let signed: Record<string, string>;
      try {
        signed = await abortable(this.#signer.sign({ method, url: new URL(url), headers: baseHeaders, bodySha256, region: this.descriptor.region ?? "us-east-1", service: "s3" }), controller.signal);
      } catch {
        if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error("S3 request aborted.");
        throw new Error("S3 request signing failed; signer details were redacted.");
      }
      for (const header of Object.keys(signed)) {
        if (["host", "content-length", "x-amz-content-sha256"].includes(header.toLowerCase())) throw new Error(`S3 signer must not override protected header ${header}.`);
      }
      const response = await abortable(this.#fetch(url, {
        method,
        headers: { ...baseHeaders, ...signed },
        ...(body ? { body: body as BodyInit } : {}),
        redirect: "error",
        signal: controller.signal
      }, { resolvedAddresses }), controller.signal);
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel("redirect refused").catch(() => undefined);
        throw new Error("S3 redirects are refused; the validated endpoint boundary cannot change.");
      }
      return { response, signal: controller.signal, release: () => clearTimeout(timer) };
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
  }

  async put(object: StorageObject): Promise<void> {
    this.assertAuthorized("write", object.key);
    const pending = await this.request("PUT", this.objectUrl(object.key), object.body, { "content-type": object.contentType });
    try {
      if (!pending.response.ok) {
        await pending.response.body?.cancel("request failed").catch(() => undefined);
        throw new Error(`S3 PUT failed with HTTP ${pending.response.status}.`);
      }
    }
    finally { pending.release(); }
  }

  async get(key: string): Promise<StorageObject | undefined> {
    const pending = await this.request("GET", this.objectUrl(key));
    try {
      const { response } = pending;
      if (response.status === 404) { await response.body?.cancel("not found").catch(() => undefined); return undefined; }
      if (!response.ok) { await response.body?.cancel("request failed").catch(() => undefined); throw new Error(`S3 GET failed with HTTP ${response.status}.`); }
      const body = await boundedBody(response, this.descriptor.maxDownloadBytes, pending.signal);
      return {
        key,
        body,
        etag: (response.headers.get("etag") ?? createHash("sha256").update(body).digest("hex")).replaceAll("\"", ""),
        size: body.byteLength,
        updatedAt: response.headers.get("last-modified") ? new Date(response.headers.get("last-modified")!).toISOString() : new Date(0).toISOString(),
        contentType: response.headers.get("content-type") ?? "application/octet-stream"
      };
    } finally { pending.release(); }
  }

  async delete(key: string): Promise<boolean> {
    this.assertAuthorized("delete", key);
    const pending = await this.request("DELETE", this.objectUrl(key));
    try {
      if (pending.response.status === 404) { await pending.response.body?.cancel("not found").catch(() => undefined); return false; }
      if (!pending.response.ok) { await pending.response.body?.cancel("request failed").catch(() => undefined); throw new Error(`S3 DELETE failed with HTTP ${pending.response.status}.`); }
      return true;
    } finally { pending.release(); }
  }

  async list(prefix: string): Promise<StorageObjectMetadata[]> {
    const url = new URL(this.endpoint);
    const endpointPath = url.pathname.replace(/\/$/, "");
    if (this.descriptor.pathStyle !== false) url.pathname = `${endpointPath}/${encodeURIComponent(this.bucket)}`;
    else url.hostname = `${this.bucket}.${url.hostname}`;
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", this.objectKey(prefix));
    const requestedRemotePrefix = this.objectKey(prefix);
    const pending = await this.request("GET", url);
    try {
      const { response } = pending;
      if (!response.ok) { await response.body?.cancel("request failed").catch(() => undefined); throw new Error(`S3 LIST failed with HTTP ${response.status}.`); }
      const body = new TextDecoder().decode(await boundedBody(response, Math.min(this.descriptor.maxDownloadBytes, 4 * 1024 * 1024), pending.signal));
      return [...body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].flatMap((match) => {
        const block = match[1] ?? "";
        const remoteKey = xmlValue(block, "Key");
        const size = Number(xmlValue(block, "Size") ?? "NaN");
        if (!remoteKey || !Number.isFinite(size) || !remoteKey.startsWith(requestedRemotePrefix) || !this.withinConfiguredPrefix(remoteKey)) return [];
        const key = this.prefix ? remoteKey.slice(this.prefix.length + 1) : remoteKey;
        try { validateStorageKey(key); } catch { return []; }
        return [{ key, size, etag: (xmlValue(block, "ETag") ?? "").replaceAll("\"", ""), updatedAt: new Date(xmlValue(block, "LastModified") ?? 0).toISOString(), contentType: "application/octet-stream" }];
      });
    } finally { pending.release(); }
  }

  private withinConfiguredPrefix(remoteKey: string): boolean {
    return !this.prefix || remoteKey === this.prefix || remoteKey.startsWith(`${this.prefix}/`);
  }

  private async resolveAndValidate(url: URL): Promise<readonly S3ResolvedAddress[]> {
    const hostname = normalizeHostname(url.hostname);
    if (metadataHostnames.has(hostname) || metadataAddresses.has(hostname)) throw new Error(`S3 request target ${hostname} is a cloud metadata endpoint.`);
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
      : await this.#resolver(hostname);
    if (!addresses.length) throw new Error(`DNS resolution returned no addresses for S3 endpoint ${hostname}.`);
    const scopes = new Set<AddressScope>();
    for (const result of addresses) {
      if (result.family !== 4 && result.family !== 6) throw new Error(`DNS resolver returned an invalid family for ${result.address}.`);
      const scope = addressScope(result.address);
      scopes.add(scope);
      if (scope === "metadata" || scope === "link-local" || scope === "reserved" || scope === "mapped") throw new Error(`DNS resolution for ${hostname} reached forbidden ${scope} address ${result.address}.`);
      if (scope !== "public" && !explicitLocalMode(this.descriptor)) {
        throw new Error(`DNS resolution for ${hostname} reached ${scope} address ${result.address}; local/private access requires both explicit flags.`);
      }
    }
    if (scopes.has("public") && [...scopes].some((scope) => scope !== "public")) throw new Error(`DNS resolution for ${hostname} mixed public and local/private address scopes.`);
    return addresses.map((result) => Object.freeze({ address: result.address, family: result.family }));
  }
}

interface SecuredResponse {
  response: Response;
  signal: AbortSignal;
  release(): void;
}

const defaultResolver: S3DnsResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => ({ address: result.address, family: result.family as 4 | 6 }));
};

const pinnedHttpFetch: S3Fetch = async (url, init, context) => {
  if (!context?.resolvedAddresses.length) throw new Error("S3 transport requires prevalidated DNS addresses.");
  const addresses = context.resolvedAddresses;
  const first = addresses[0]!;
  const pinnedLookup: NonNullable<HttpRequestOptions["lookup"]> = (_hostname, options, callback) => {
    if (options.all) callback(null, addresses.map(({ address, family }) => ({ address, family })));
    else callback(null, first.address, first.family);
  };
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  return new Promise<Response>((resolvePromise, rejectPromise) => {
    const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requester(url, { method: init.method, headers, signal: init.signal ?? undefined, lookup: pinnedLookup }, (incoming) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((entry) => responseHeaders.append(name, entry));
        else if (value !== undefined) responseHeaders.set(name, value);
      }
      const status = incoming.statusCode ?? 500;
      const body = init.method === "HEAD" || status === 204 || status === 205 || status === 304
        ? null
        : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolvePromise(new Response(body, { status, ...(incoming.statusMessage === undefined ? {} : { statusText: incoming.statusMessage }), headers: responseHeaders }));
    });
    request.once("error", rejectPromise);
    if (init.body === undefined || init.body === null) request.end();
    else if (init.body instanceof Uint8Array) request.end(init.body);
    else { request.destroy(); rejectPromise(new Error("S3 transport only accepts Uint8Array request bodies.")); }
  });
};

function validateAuthorizationPrefixes(values: string[] | undefined, field: string): readonly string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${field} must be a non-empty array when provided.`);
  const prefixes = values.map((value) => validateStorageKey(value));
  if (new Set(prefixes).size !== prefixes.length) throw new Error(`${field} must not contain duplicate prefixes.`);
  return Object.freeze(prefixes);
}

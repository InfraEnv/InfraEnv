import { randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionTokens } from "@infraenv/shared";

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function createSessionTokens(): SessionTokens {
  return { hostToken: randomToken(), sandboxToken: randomToken(), uiLaunchToken: randomToken() };
}

export function secureEqual(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

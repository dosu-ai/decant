import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readStorage, removeStorage, writeStorage } from "../src/ui/safe-storage.ts";

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installStorage(storage: unknown) {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
}

function restoreStorage() {
  if (original == null) {
    Reflect.deleteProperty(globalThis, "localStorage");
  } else {
    Object.defineProperty(globalThis, "localStorage", original);
  }
}

describe("safe storage", () => {
  beforeEach(restoreStorage);
  afterEach(restoreStorage);

  test("round-trips values when storage works", () => {
    const map = new Map<string, string>();
    installStorage({
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    });
    writeStorage("k", "v");
    expect(readStorage("k")).toBe("v");
    removeStorage("k");
    expect(readStorage("k")).toBeNull();
  });

  test("swallows every failure when storage throws", () => {
    const boom = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    installStorage({ getItem: boom, setItem: boom, removeItem: boom });
    expect(readStorage("k")).toBeNull();
    expect(() => writeStorage("k", "v")).not.toThrow();
    expect(() => removeStorage("k")).not.toThrow();
  });

  test("treats a missing storage object as empty", () => {
    Reflect.deleteProperty(globalThis, "localStorage");
    expect(readStorage("k")).toBeNull();
    expect(() => writeStorage("k", "v")).not.toThrow();
  });
});

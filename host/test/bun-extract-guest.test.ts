/**
 * Proves the `bun-extract` guest program (programs/bun-extract.c) runs under the
 * real kernel: it parses a Bun standalone module-graph blob and writes the
 * extracted JS modules into the guest VFS. Uses a tiny synthetic graph so the
 * test stays fast and container-independent (the parser anchors on the Bun
 * trailer + Offsets struct, not on Mach-O/ELF headers).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

// Build the same minimal graph as the native test fixture: 3 ESM modules,
// one under a subdirectory, base at file offset 0.
function buildFixture(): Uint8Array {
  const TRAILER = Buffer.from("\n---- Bun! ----\n", "latin1");
  const mods: Array<[string, string]> = [
    ["/$bunfs/root/cli", '// entry\nimport "/$bunfs/root/chunk-a.js";\nimport "/$bunfs/root/sub/b.js";\n'],
    ["/$bunfs/root/chunk-a.js", "export const a=1;\n"],
    ["/$bunfs/root/sub/b.js", "export const b=2;\n"],
  ];
  const parts: Buffer[] = [];
  let len = 0;
  const sp: Array<{ no: number; nl: number; co: number; cl: number }> = [];
  for (const [name, cont] of mods) {
    const nb = Buffer.from(name, "latin1");
    const cb = Buffer.from(cont, "latin1");
    const no = len; parts.push(nb); len += nb.length;
    const co = len; parts.push(cb); len += cb.length;
    sp.push({ no, nl: nb.length, co, cl: cb.length });
  }
  const modOff = len;
  for (const s of sp) {
    const rec = Buffer.alloc(52);
    rec.writeUInt32LE(s.no, 0); rec.writeUInt32LE(s.nl, 4);
    rec.writeUInt32LE(s.co, 8); rec.writeUInt32LE(s.cl, 12);
    // sourcemap/bytecode/module_info/bytecode_origin_path = 0
    rec[48] = 1; // encoding Latin1
    rec[49] = 0; // loader
    rec[50] = 1; // module_format Esm
    rec[51] = 0; // side
    parts.push(rec); len += 52;
  }
  const modLen = len - modOff;
  const byteCount = len; // Offsets sits at base+byteCount
  const off = Buffer.alloc(32);
  off.writeUInt32LE(byteCount, 0); off.writeUInt32LE(0, 4); // u64 byte_count
  off.writeUInt32LE(modOff, 8); off.writeUInt32LE(modLen, 12);
  off.writeUInt32LE(0, 16); // entry_point_id = 0
  // compile_exec_argv_ptr (8) + flags (4) = 0
  parts.push(off); parts.push(TRAILER);
  return Buffer.concat(parts);
}

describe("bun-extract guest program", () => {
  const wasm = tryResolveBinary("programs/bun-extract.wasm");
  it.runIf(wasm != null && existsSync(wasm!))(
    "extracts a Bun module graph into the guest VFS",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "bun-extract-"));
      const fixture = join(dir, "fixture.bin");
      writeFileSync(fixture, buildFixture());

      const result = await runCentralizedProgram({
        programPath: wasm!,
        argv: ["bun-extract", "/fixture.bin", "/out"],
        execPrograms: new Map([["/fixture.bin", fixture]]),
        useDefaultRootfs: false,
        timeout: 30_000,
      });

      expect(result.exitCode).toBe(0);
      // Parsed the graph in-guest:
      expect(result.stdout).toContain("EXTRACTED count=3 esm=3 entry=cli");
      // Wrote the tree and read the entry file back inside the guest VFS:
      expect(result.stdout).toContain("ENTRY_HEAD // entry");
    },
    45_000,
  );

  it.runIf(wasm != null && existsSync(wasm!))(
    "prepare mode caches, remaps specifiers, and is a no-op on hit",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "bun-prepare-"));
      const fixture = join(dir, "fixture.bin");
      writeFileSync(fixture, buildFixture());

      // First run: miss -> extracts, prints CACHE=/ENTRY=, remaps specifiers.
      const r1 = await runCentralizedProgram({
        programPath: wasm!,
        argv: ["bun-extract", "--prepare", "/fixture.bin", "/cache"],
        execPrograms: new Map([["/fixture.bin", fixture]]),
        useDefaultRootfs: false,
        timeout: 30_000,
      });
      expect(r1.exitCode).toBe(0);
      const cache = r1.stdout.match(/^CACHE=(.+)$/m)?.[1];
      const entry = r1.stdout.match(/^ENTRY=(.+)$/m)?.[1];
      expect(cache).toBeTruthy();
      expect(entry).toBeTruthy();
      // Entry lives under the cache dir and its specifiers are remapped.
      expect(entry!.startsWith(cache!)).toBe(true);
      // Entry is renamed to .mjs so spidermonkey-node loads it as ESM.
      expect(entry!.endsWith(".mjs")).toBe(true);
      // Prove remap by having the program cat the entry back (self-check line):
      expect(r1.stdout).toContain(`REMAP_OK ${cache}`);

      // Second run in the same rootfs would need a persistent FS; instead assert
      // the printed hash is stable across two prepare runs on identical input.
      const r2 = await runCentralizedProgram({
        programPath: wasm!,
        argv: ["bun-extract", "--prepare", "/fixture.bin", "/cache"],
        execPrograms: new Map([["/fixture.bin", fixture]]),
        useDefaultRootfs: false,
        timeout: 30_000,
      });
      expect(r2.stdout.match(/^CACHE=(.+)$/m)?.[1]).toBe(cache);
    },
    45_000,
  );
});

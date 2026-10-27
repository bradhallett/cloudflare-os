// Pure-logic coverage for git-diff.ts: tree-object parsing, the pruning tree-to-tree walk, the
// line-level unified diff, and the unified-patch reader whose hunks the diff must match.

import { describe, expect, it } from "vitest";
import {
  MAX_DIFF_BLOB_BYTES,
  TreeUnavailableError,
  changedPathsBetweenTrees,
  diffGitTrees,
  parseGitTreePayload,
  parseUnifiedPatch,
  type GitTreeEntry,
  type TreeDiffSource,
} from "../src/git-diff";

/** Deterministic fake full oid. */
function oid(n: number): string {
  return n.toString(16).padStart(40, "0");
}

function treePayload(entries: { mode: string; name: string; oid: string }[]): Uint8Array {
  const encoder = new TextEncoder();
  const pieces = entries.flatMap(entry => {
    const oidBytes = new Uint8Array(20);
    for (let i = 0; i < 20; i++) {
      oidBytes[i] = parseInt(entry.oid.slice(i * 2, i * 2 + 2), 16);
    }
    return [encoder.encode(`${entry.mode} ${entry.name}\0`), oidBytes];
  });
  const out = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.byteLength;
  }
  return out;
}

/** An in-memory TreeDiffSource that records which objects were fetched. */
function fakeSource(
  trees: Record<string, GitTreeEntry[]>,
  blobs: Record<string, Uint8Array | "unavailable">,
) {
  const treeReads: string[] = [];
  const blobReads: string[] = [];
  const source: TreeDiffSource = {
    getTree: async id => {
      treeReads.push(id);
      return trees[id] ?? null;
    },
    getBlob: async id => {
      blobReads.push(id);
      return blobs[id] ?? "unavailable";
    },
  };
  return { source, treeReads, blobReads };
}

const text = (value: string) => new TextEncoder().encode(value);

describe("parseGitTreePayload", () => {
  it("round-trips modes, names, and oids", () => {
    const entries = [
      { mode: "100644", name: "a.txt", oid: oid(1) },
      { mode: "40000", name: "sub", oid: oid(2) },
      { mode: "100755", name: "run.sh", oid: oid(3) },
      { mode: "120000", name: "link", oid: oid(4) },
      { mode: "160000", name: "vendored", oid: oid(5) },
    ];
    expect(parseGitTreePayload(treePayload(entries), oid(9))).toEqual(entries);
  });

  it("rejects truncated payloads and non-UTF-8 names", () => {
    const good = treePayload([{ mode: "100644", name: "a", oid: oid(1) }]);
    expect(() => parseGitTreePayload(good.subarray(0, good.length - 1), oid(9)))
      .toThrow(/not a well-formed tree/);

    const badName = new Uint8Array([...text("100644 "), 0xff, 0, ...new Uint8Array(20)]);
    expect(() => parseGitTreePayload(badName, oid(9))).toThrow(/non-UTF-8 entry name/);
  });

  it("keeps a leading BOM in an entry name, so it cannot alias the BOM-less name", () => {
    const entries = [
      { mode: "100644", name: "a.txt", oid: oid(1) },
      { mode: "100644", name: "\uFEFFa.txt", oid: oid(2) },
    ];
    expect(parseGitTreePayload(treePayload(entries), oid(9))).toEqual(entries);
  });
});


describe("parseUnifiedPatch", () => {
  it("reads no line past a patch's final newline", () => {
    // Read as a line, the empty string after the last newline would be a blank context line past
    // the end of the hunk, there to comment on.
    const [hunk] = parseUnifiedPatch("@@ -1,2 +1,2 @@\n a\n-b\n+c\n");
    expect(hunk.lines).toEqual([
      { kind: "context", text: "a", oldLineNumber: 1, newLineNumber: 1 },
      { kind: "removed", text: "b", oldLineNumber: 2 },
      { kind: "added", text: "c", newLineNumber: 2 },
    ]);
  });

  it("skips a diff --git preamble and restarts numbering at each hunk header", () => {
    const patch = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n@@ -10,2 +9,0 @@ fn()\n-c\n-d";
    expect(parseUnifiedPatch(patch)).toEqual([
      {
        header: "@@ -1 +1 @@",
        lines: [{ kind: "removed", text: "a", oldLineNumber: 1 }, { kind: "added", text: "b", newLineNumber: 1 }],
      },
      {
        header: "@@ -10,2 +9,0 @@ fn()",
        lines: [{ kind: "removed", text: "c", oldLineNumber: 10 }, { kind: "removed", text: "d", oldLineNumber: 11 }],
      },
    ]);
  });
});

describe("diffGitTrees", () => {
  // Old tree: a.txt (edited), sub/x.txt (unchanged), big.bin (unchanged).
  // New tree adds sub/y.txt.
  const trees: Record<string, GitTreeEntry[]> = {
    [oid(10)]: [
      { mode: "100644", name: "a.txt", oid: oid(1) },
      { mode: "100644", name: "big.bin", oid: oid(5) },
      { mode: "40000", name: "sub", oid: oid(11) },
    ],
    [oid(20)]: [
      { mode: "100644", name: "a.txt", oid: oid(2) },
      { mode: "100644", name: "big.bin", oid: oid(5) },
      { mode: "40000", name: "sub", oid: oid(21) },
    ],
    [oid(11)]: [{ mode: "100644", name: "x.txt", oid: oid(3) }],
    [oid(21)]: [
      { mode: "100644", name: "x.txt", oid: oid(3) },
      { mode: "100644", name: "y.txt", oid: oid(4) },
    ],
  };
  const blobs: Record<string, Uint8Array | "unavailable"> = {
    [oid(1)]: text("hello\nworld\n"),
    [oid(2)]: text("hello\nthere\nworld\n"),
    [oid(4)]: text("new file\n"),
  };

  it("diffs changed files, prunes unchanged entries, and never loads untouched blobs", async () => {
    const { source, blobReads } = fakeSource(trees, blobs);
    const files = await diffGitTrees(source, oid(10), oid(20));

    expect(files.map(file => [file.path, file.status])).toEqual([
      ["a.txt", "modified"],
      ["sub/y.txt", "added"],
    ]);
    const [aTxt, yTxt] = files;
    expect(aTxt.additions).toBe(1);
    expect(aTxt.deletions).toBe(0);
    expect(aTxt.diffOmitted).toBe(false);
    expect(aTxt.hunks[0].lines).toContainEqual({ kind: "added", text: "there", newLineNumber: 2 });
    expect(yTxt.additions).toBe(1);
    expect(yTxt.hunks[0].header).toBe("@@ -0,0 +1 @@");
    // The unchanged big.bin (same oid both sides) and x.txt must never be fetched.
    expect(blobReads).not.toContain(oid(5));
    expect(blobReads).not.toContain(oid(3));
  });

  it("treats a null old tree as empty (the whole new tree is added)", async () => {
    const { source } = fakeSource(trees, blobs);
    const files = await diffGitTrees(source, null, oid(21));
    expect(files.map(file => [file.path, file.status])).toEqual([
      ["x.txt", "added"],
      ["y.txt", "added"],
    ]);
  });

  it("reports binary, oversized, and unavailable content as diffOmitted", async () => {
    const binary = new Uint8Array([1, 2, 0, 3]);
    const huge = new Uint8Array(MAX_DIFF_BLOB_BYTES + 1);
    huge.fill(0x61);
    const { source } = fakeSource(
      {
        [oid(30)]: [],
        [oid(31)]: [
          { mode: "100644", name: "bin.dat", oid: oid(6) },
          { mode: "100644", name: "huge.txt", oid: oid(7) },
          { mode: "100644", name: "gone.txt", oid: oid(8) },
        ],
      },
      { [oid(6)]: binary, [oid(7)]: huge, [oid(8)]: "unavailable" },
    );
    const files = await diffGitTrees(source, oid(30), oid(31));
    expect(files).toHaveLength(3);
    for (const file of files) {
      expect(file.status).toBe("added");
      expect(file.diffOmitted).toBe(true);
      expect(file.hunks).toEqual([]);
      expect(file.additions).toBe(0);
    }
  });

  it("reports submodule pointer and mode-only changes without a patch", async () => {
    const { source, blobReads } = fakeSource(
      {
        [oid(30)]: [
          { mode: "160000", name: "vendored", oid: oid(6) },
          { mode: "100644", name: "run.sh", oid: oid(7) },
        ],
        [oid(31)]: [
          { mode: "160000", name: "vendored", oid: oid(9) },
          { mode: "100755", name: "run.sh", oid: oid(7) },
        ],
      },
      {},
    );
    const files = await diffGitTrees(source, oid(30), oid(31));
    expect(files.map(file => [file.path, file.status, file.diffOmitted])).toEqual([
      ["run.sh", "modified", true],
      ["vendored", "modified", true],
    ]);
    expect(blobReads).toEqual([]); // neither a gitlink nor a mode-only change loads content
  });

  it("handles a directory replaced by a file", async () => {
    const { source } = fakeSource(
      {
        [oid(30)]: [{ mode: "40000", name: "thing", oid: oid(11) }],
        [oid(31)]: [{ mode: "100644", name: "thing", oid: oid(4) }],
        [oid(11)]: trees[oid(11)],
      },
      blobs,
    );
    const files = await diffGitTrees(source, oid(30), oid(31));
    expect(files.map(file => [file.path, file.status])).toEqual([
      ["thing/x.txt", "removed"],
      ["thing", "added"],
    ]);
  });

  it("shows a BOM-only content change instead of stripping it into an empty diff", async () => {
    const { source } = fakeSource(
      {
        [oid(30)]: [{ mode: "100644", name: "a.txt", oid: oid(1) }],
        [oid(31)]: [{ mode: "100644", name: "a.txt", oid: oid(2) }],
      },
      { [oid(1)]: text("hello\n"), [oid(2)]: text("\uFEFFhello\n") },
    );
    const files = await diffGitTrees(source, oid(30), oid(31));
    expect(files).toHaveLength(1);
    expect(files[0].diffOmitted).toBe(false);
    expect(files[0].hunks[0].lines).toEqual([
      { kind: "removed", text: "hello", oldLineNumber: 1 },
      { kind: "added", text: "\uFEFFhello", newLineNumber: 1 },
    ]);
  });

  it("omits the hunks, not the counts, of a file past the per-file output cap", async () => {
    // A rewrite past the edit-distance cap takes the wholesale path: every line removed and added.
    const lines = (prefix: string) =>
      text(Array.from({ length: 3000 }, (_, i) => `${prefix}${i}`).join("\n") + "\n");
    const { source } = fakeSource(
      {
        [oid(30)]: [{ mode: "100644", name: "lock.json", oid: oid(1) }],
        [oid(31)]: [{ mode: "100644", name: "lock.json", oid: oid(2) }],
      },
      { [oid(1)]: lines("old"), [oid(2)]: lines("new") },
    );
    const [file] = await diffGitTrees(source, oid(30), oid(31));
    expect(file).toEqual({
      path: "lock.json", status: "modified", additions: 3000, deletions: 3000,
      diffOmitted: true, hunks: [],
    });
  });

  it("still emits a large added file under the per-file output cap in full", async () => {
    const added = Array.from({ length: 2000 }, (_, i) => `line${i}`);
    const { source } = fakeSource(
      { [oid(30)]: [], [oid(31)]: [{ mode: "100644", name: "gen.txt", oid: oid(1) }] },
      { [oid(1)]: text(added.join("\n") + "\n") },
    );
    const [file] = await diffGitTrees(source, oid(30), oid(31));
    expect(file.diffOmitted).toBe(false);
    expect(file.additions).toBe(2000);
    expect(file.hunks[0].lines.map(line => line.text)).toEqual(added);
  });

  it("omits the remaining files once the total output budget is spent", async () => {
    const count = 12;
    const content = text(Array.from({ length: 1000 }, () => "x".repeat(100)).join("\n") + "\n");
    const names = Array.from({ length: count }, (_, i) => `f${String(i).padStart(2, "0")}.txt`);
    const { source } = fakeSource(
      { [oid(30)]: [], [oid(31)]: names.map(name => ({ mode: "100644", name, oid: oid(1) })) },
      { [oid(1)]: content },
    );
    // Each file fits the per-file cap, but together they overrun the total.
    const files = await diffGitTrees(source, oid(30), oid(31));
    const emitted = files.filter(file => !file.diffOmitted);
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.length).toBeLessThan(count);
    expect(files.map(file => file.diffOmitted)).toEqual(
      names.map((_, i) => i >= emitted.length));
    for (const file of files) expect(file.additions).toBe(1000);
  });

  it("throws TreeUnavailableError when a needed tree cannot be loaded", async () => {
    const { source } = fakeSource({ [oid(30)]: [{ mode: "40000", name: "sub", oid: oid(99) }] }, {});
    await expect(diffGitTrees(source, oid(30), null)).rejects.toThrow(TreeUnavailableError);
  });
});

describe("changedPathsBetweenTrees", () => {
  it("lists changed paths without loading any blob", async () => {
    const trees: Record<string, GitTreeEntry[]> = {
      [oid(10)]: [
        { mode: "100644", name: "a.txt", oid: oid(1) },
        { mode: "40000", name: "sub", oid: oid(11) },
      ],
      [oid(20)]: [
        { mode: "100644", name: "a.txt", oid: oid(2) },
        { mode: "40000", name: "sub", oid: oid(21) },
      ],
      [oid(11)]: [{ mode: "100644", name: "x.txt", oid: oid(3) }],
      [oid(21)]: [{ mode: "100644", name: "x.txt", oid: oid(4) }],
    };
    const { source, blobReads } = fakeSource(trees, {});
    expect(await changedPathsBetweenTrees(source, oid(10), oid(20)))
      .toEqual(["a.txt", "sub/x.txt"]);
    expect(blobReads).toEqual([]);
  });
});

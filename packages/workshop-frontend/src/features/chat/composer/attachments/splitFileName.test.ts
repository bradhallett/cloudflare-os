import {describe, expect, it} from "vitest";
import {splitFileName} from "./splitFileName";

describe("splitFileName", () => {
  it("splits a regular name into base and extension", () => {
    expect(splitFileName("report.pdf")).toEqual({base: "report", extension: ".pdf"});
  });

  it("keeps only the final extension of a doubly-suffixed name", () => {
    expect(splitFileName("archive.tar.gz")).toEqual({base: "archive.tar", extension: ".gz"});
  });

  it("accepts an extension of at most 8 characters including the dot", () => {
    expect(splitFileName("a.docx")).toEqual({base: "a", extension: ".docx"});
    expect(splitFileName("a.docxlsx")).toEqual({base: "a", extension: ".docxlsx"});
    expect(splitFileName("a.docxsxyz")).toBeNull();
  });

  it("returns null when there is no extension to preserve", () => {
    expect(splitFileName("Makefile")).toBeNull();
    expect(splitFileName(".bashrc")).toBeNull();
    expect(splitFileName("no-extension.")).toBeNull();
  });
});

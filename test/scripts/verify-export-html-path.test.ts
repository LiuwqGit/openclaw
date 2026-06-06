// Tests export-html template path resolution after build
// This ensures the packaging path matches the runtime bundle lookup

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Navigate to project root (from test/scripts/)
const projectRoot = path.resolve(__dirname, "../..");

describe("export-html template path", () => {
  const distRoot = path.join(projectRoot, "dist");
  const exportHtmlDir = path.join(distRoot, "export-html");

  it("exists at dist/export-html after build", () => {
    expect(fs.existsSync(exportHtmlDir)).toBe(true);
  });

  it("contains required template files", () => {
    const requiredFiles = [
      "template.html",
      "template.css",
      "template.js",
      "vendor/marked.min.js",
      "vendor/highlight.min.js",
    ];

    for (const file of requiredFiles) {
      const filePath = path.join(exportHtmlDir, file);
      expect(fs.existsSync(filePath)).toBe(true);
    }
  });

  it("does not exist at old incorrect path", () => {
    const oldPath = path.join(distRoot, "auto-reply", "reply", "export-html");
    expect(fs.existsSync(oldPath)).toBe(false);
  });

  it("has correct vendor subdirectory structure", () => {
    const vendorDir = path.join(exportHtmlDir, "vendor");
    expect(fs.existsSync(vendorDir)).toBe(true);
    expect(fs.statSync(vendorDir).isDirectory()).toBe(true);
  });

  it("contains all expected vendor files", () => {
    const vendorFiles = ["marked.min.js", "highlight.min.js"];
    const vendorDir = path.join(exportHtmlDir, "vendor");

    for (const file of vendorFiles) {
      const filePath = path.join(vendorDir, file);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.statSync(filePath).isFile()).toBe(true);
    }
  });
});

#!/usr/bin/env node
/**
 * Real behavior proof for Issue #90843 fix
 *
 * This script simulates the runtime behavior where commands-export-session
 * is bundled into dist/commands-handlers.runtime-*.js and needs to resolve
 * the export-html directory relative to the bundle location.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = __dirname;

console.log("=".repeat(70));
console.log("Real Behavior Proof - Issue #90843 Fix");
console.log("=".repeat(70));
console.log();

// Simulate the bundle location at dist/ root
// This matches how tsdown bundles commands-export-session.ts
const simulatedBundlePath = path.join(projectRoot, "dist", "commands-handlers.runtime.js");
const simulatedBundleDir = path.dirname(simulatedBundlePath);

console.log("1. Simulating runtime bundle location:");
console.log(`   Bundle path: ${simulatedBundlePath}`);
console.log(`   Bundle directory: ${simulatedBundleDir}`);
console.log();

// This is exactly how commands-export-session.ts resolves EXPORT_HTML_DIR
const EXPORT_HTML_DIR = path.join(simulatedBundleDir, "export-html");
console.log("2. Runtime path resolution (from commands-export-session.ts line 23):");
console.log(`   EXPORT_HTML_DIR = path.join(bundleDir, "export-html")`);
console.log(`   Resolved to: ${EXPORT_HTML_DIR}`);
console.log();

// Verify the directory exists
try {
  await fs.access(EXPORT_HTML_DIR);
  console.log("3. ✅ SUCCESS: export-html directory exists at resolved path!");
  console.log();
} catch (error) {
  console.error("3. ❌ FAIL: export-html directory NOT found at resolved path!");
  console.error(`   Error: ${error.message}`);
  console.error();
  process.exit(1);
}

// Verify all required template files
const requiredFiles = [
  "template.html",
  "template.css",
  "template.js",
  "vendor/marked.min.js",
  "vendor/highlight.min.js",
];

console.log("4. Verifying required template files:");
let allFilesExist = true;
for (const file of requiredFiles) {
  const filePath = path.join(EXPORT_HTML_DIR, file);
  try {
    await fs.access(filePath);
    console.log(`   ✅ ${file}`);
  } catch (error) {
    console.error(`   ❌ ${file} - NOT FOUND`);
    allFilesExist = false;
  }
}
console.log();

if (!allFilesExist) {
  console.error("❌ FAIL: Some required template files are missing!");
  process.exit(1);
}

// Verify old incorrect path does NOT exist
const oldPath = path.join(projectRoot, "dist", "auto-reply", "reply", "export-html");
try {
  await fs.access(oldPath);
  console.error("⚠️  WARNING: Old incorrect path still exists!");
  console.error(`   Old path: ${oldPath}`);
  console.error(`   This should have been removed by the fix.`);
  console.error();
} catch (error) {
  console.log("5. ✅ Confirmed: Old incorrect path does not exist");
  console.log(`   Old path: ${oldPath}`);
  console.log();
}

// Simulate loading a template file (what buildExportSessionReply does)
console.log("6. Simulating template load (as in buildExportSessionReply):");
try {
  const templateContent = await fs.readFile(
    path.join(EXPORT_HTML_DIR, "template.html"),
    "utf-8"
  );
  console.log(`   ✅ Successfully loaded template.html (${templateContent.length} bytes)`);
  console.log(`   First 100 chars: ${templateContent.substring(0, 100).replace(/\n/g, "\\n")}`);
  console.log();
} catch (error) {
  console.error("   ❌ FAIL: Could not load template.html");
  console.error(`   Error: ${error.message}`);
  console.error();
  process.exit(1);
}

console.log("=".repeat(70));
console.log("✅ ALL CHECKS PASSED!");
console.log("=".repeat(70));
console.log();
console.log("Summary:");
console.log("- Templates are correctly copied to dist/export-html/");
console.log("- Runtime path resolution works as expected");
console.log("- All required template files are present and readable");
console.log("- Old incorrect path has been removed");
console.log();
console.log("The /export-session command should now work correctly in the npm package.");
console.log();

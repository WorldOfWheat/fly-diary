#!/usr/bin/env node
// Apply the Android security overlay to the Tauri-generated project.
//
// src-tauri/gen/android is intentionally gitignored (it is a generated Gradle
// project), so the backup and screenshot rules live in this idempotent script
// instead of a handful of force-added generated files. Run it after
// `tauri android init`, or use the android:init/android:dev/android:build
// package scripts.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const androidDir = join(root, "src-tauri", "gen", "android");
const manifestPath = join(
  androidDir,
  "app",
  "src",
  "main",
  "AndroidManifest.xml",
);

if (!existsSync(manifestPath)) {
  console.error(
    "Android project not found. Run `pnpm tauri android init` first.",
  );
  process.exit(1);
}

function patchManifest() {
  let xml = readFileSync(manifestPath, "utf8");
  if (xml.includes('android:allowBackup="false"')) {
    xml = xml.replace('android:allowBackup="false"', 'android:allowBackup="true"');
  } else if (!xml.includes('android:allowBackup="true"')) {
    xml = xml.replace(
      /<application\b/,
      '<application\n        android:allowBackup="true"',
    );
  }
  if (!xml.includes("android:dataExtractionRules=")) {
    xml = xml.replace(
      /<application\b/,
      '<application\n        android:dataExtractionRules="@xml/data_extraction_rules"',
    );
  }
  if (!xml.includes("android:fullBackupContent=")) {
    xml = xml.replace(
      /<application\b/,
      '<application\n        android:fullBackupContent="@xml/backup_rules"',
    );
  }
  writeFileSync(manifestPath, xml);
}

function patchMainActivity() {
  const javaDir = join(androidDir, "app", "src", "main", "java");
  if (!existsSync(javaDir)) return;
  const candidates = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "MainActivity.kt") candidates.push(path);
    }
  };
  walk(javaDir);
  for (const path of candidates) {
    let source = readFileSync(path, "utf8");
    if (!source.includes("import android.view.WindowManager")) {
      source = source.replace(
        /import android\.os\.Bundle\n/,
        "import android.os.Bundle\nimport android.view.WindowManager\n",
      );
    }
    if (!source.includes("FLAG_SECURE")) {
      source = source.replace(
        /super\.onCreate\(savedInstanceState\)\n/,
        "super.onCreate(savedInstanceState)\n    // Keep diary plaintext out of screenshots, screen recordings and recents.\n    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)\n",
      );
    }
    writeFileSync(path, source);
  }
}

const xmlDir = join(androidDir, "app", "src", "main", "res", "xml");
mkdirSync(xmlDir, { recursive: true });

writeFileSync(
  join(xmlDir, "data_extraction_rules.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<!-- Keep the encrypted diary restorable, but only when Android can encrypt
     the cloud backup. The recovery phrase itself is not stored here. -->
<data-extraction-rules>
    <cloud-backup disableIfNoEncryptionCapabilities="true">
        <include domain="file" path="." />
        <exclude domain="file" path="cache" />
    </cloud-backup>
    <device-transfer>
        <include domain="file" path="." />
    </device-transfer>
</data-extraction-rules>
`,
);

writeFileSync(
  join(xmlDir, "backup_rules.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<!-- Android 11 and older. Same rationale as data_extraction_rules.xml. -->
<full-backup-content>
    <include domain="file" path="." />
    <exclude domain="file" path="cache" />
</full-backup-content>
`,
);

patchManifest();
patchMainActivity();
console.log("Applied Android backup and FLAG_SECURE hardening.");

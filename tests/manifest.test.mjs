import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { MODULE_ID } from "../scripts/ambient-playback.mjs";

test("the manifest declares the Region behavior subtype for server registration", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../module.json", import.meta.url), "utf8"),
  );

  assert.equal(manifest.id, MODULE_ID);
  assert.equal(manifest.id, "footstep-sounds");
  assert.equal(manifest.title, "Footstep Sounds");
  assert.deepEqual(manifest.documentTypes?.RegionBehavior, { surface: {} });

  const source = await readFile(
    new URL("../scripts/main.mjs", import.meta.url),
    "utf8",
  );

  assert.ok(source.includes("const BEHAVIOR_TYPE = `${MODULE_ID}.surface`;"));
});

test("the behavior label resolves through a manifest-declared translation catalog", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../module.json", import.meta.url), "utf8"),
  );

  const english = manifest.languages.find((language) => language.lang === "en");
  assert.ok(english);

  const translations = JSON.parse(
    await readFile(new URL(`../${english.path}`, import.meta.url), "utf8"),
  );

  const source = await readFile(
    new URL("../scripts/main.mjs", import.meta.url),
    "utf8",
  );

  const labelKey = source.match(
    /typeLabels\[BEHAVIOR_TYPE\]\s*=\s*"([^"]+)"/,
  )[1];

  const label = labelKey
    .split(".")
    .reduce((value, key) => value?.[key], translations);

  assert.equal(typeof label, "string");
  assert.ok(label.trim().length > 0);
  assert.notEqual(label, labelKey);
});

test("all literal translation keys used by runtime scripts exist in the English catalog", async () => {
  const translations = JSON.parse(
    await readFile(new URL("../lang/en.json", import.meta.url), "utf8"),
  );

  let count = 0;
  for (const file of [
    "main.mjs",
    "emitters.mjs",
    "ambient-playback.mjs",
    "movement.mjs",
  ]) {
    const source = await readFile(
      new URL(`../scripts/${file}`, import.meta.url),
      "utf8",
    );

    for (const match of source.matchAll(/"(footstep-sounds\.[^"]+)"/g)) {
      const key = match[1];
      const value = key
        .split(".")
        .reduce((entry, part) => entry?.[part], translations);
      assert.equal(
        typeof value,
        "string",
        `${file}: missing translation ${key}`,
      );
      assert.ok(value.trim().length > 0);
      count++;
    }
  }

  assert.ok(count >= 18);
});

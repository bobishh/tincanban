import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import { transform } from "lightningcss"
import { lintStyles } from "./check-css.mjs"

test("Given CSS with an unknown property, when linted, then validation fails", async () => {
  assert.ok((await lintStyles("fixture.css", "a { colro: red; } ")).some(message => message.ruleId === "css/no-invalid-properties"))
})

test("Given Vue or HTML with duplicate selectors, when styles are linted, then errors retain source lines", async () => {
  for (const file of ["fixture.vue", "fixture.html"]) {
    const messages = await lintStyles(file, '<template><p>text</p></template>\n<style>\na { color: red; }\na { margin: 0; }\n</style>')
    assert.ok(messages.some(message => message.ruleId === "css/no-duplicate-selectors" && message.line === 4))
  }
})

test("Given fallback declarations and responsive overrides, when linted, then legitimate repetition passes", async () => {
  assert.deepEqual(await lintStyles("fixture.css", 'a { display: block; display: grid; } @media (width < 400px) { a { display: flex; } }'), [])
})

test("Given duplicate declarations and empty blocks, when linted, then both are rejected", async () => {
  const messages = await lintStyles("fixture.css", 'a { color: red; color: red; } b {}')
  assert.ok(messages.some(message => message.ruleId === "css/no-duplicate-declarations"))
  assert.ok(messages.some(message => message.ruleId === "css/no-empty-blocks"))
})

// Check the shipped serialization, since the browser discards empty declarations.
test("Given shared ink exclusions, when production CSS is minified, then declarations remain valid", async () => {
  const source = await readFile(new URL("../public/assets/primitive.css", import.meta.url))
  const compiled = transform({ filename: "primitive.css", code: source, minify: true }).code.toString()
  assert.deepEqual(await lintStyles("primitive.css", compiled), [])
})

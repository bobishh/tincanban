import { readFileSync, writeFileSync } from "node:fs"

// Fill, stroke, and focus reuse one path per stable identity. Fragment targets
// select palette colors without duplicating a sprite's entire drawing tree.
const palette = {
  white: "#ffffff", panel: "#fffdf7", ink: "#171717", danger: "#9d2f21",
  red: "#ff5a36", yellow: "#ffd43b", soft: "#e9e5db", transparent: "none",
  watch: "#f1f1f1", aged: "#e2e2e2", overdue: "#d0d0d0", own: "#fef9db",
}
const colors = Object.entries(palette)
const targets = colors.map(([name]) => `<g id="${name}"/>`).join("")
const styles = `<style>.surface{fill:#fff}${colors.map(([name, color]) => `#${name}:target~.surface{fill:${color}}`).join("")}</style>`
for (const index of [0, 1, 2]) {
  const original = readFileSync(new URL(`../public/assets/ink-frame-${index}.svg`, import.meta.url), "utf8")
  const path = original.match(/<path d="([^"]+)"/)[1]
  for (const focus of [false, true]) {
    const size = focus ? 192 : 150
    const outer = focus ? `<path d="${path}" transform="translate(96 96) scale(1.27) translate(-75 -75)" fill="none" stroke="#171717" stroke-width="4" stroke-linecap="round" stroke-dasharray=".2 8 .35 10 .15 7 .25 9"/>` : ""
    const transform = focus ? ' transform="translate(21 21)"' : ""
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${styles}${outer}${targets}<path class="surface" d="${path}"${transform} stroke="#171717" stroke-width="5" stroke-linecap="square" stroke-linejoin="miter"/></svg>\n`
    writeFileSync(new URL(`../public/assets/ink-${focus ? "focus" : "surface"}-${index}.svg`, import.meta.url), svg)
  }
}

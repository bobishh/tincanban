import css from "@eslint/css"

export default [{
  files: ["**/*.css"],
  language: "css/css",
  plugins: { css },
  languageOptions: {
    customSyntax: base => ({ ...base, properties: { ...base.properties, appearance: `${base.properties.appearance} | base-select` } }),
  },
  rules: {
    ...css.configs.recommended.rules,
    "css/no-invalid-properties": ["error", { allowUnknownVariables: true }],
    // Existing ink frames and reduced-motion overrides deliberately use !important.
    "css/no-important": "off",
    // Browser compatibility and font tokens are covered by real-route tests.
    "css/use-baseline": "off",
    "css/font-family-fallbacks": "off",
  },
}]

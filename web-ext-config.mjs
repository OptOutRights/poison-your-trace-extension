// web-ext packages the extension from this directory; ship only the manifest, the built dist/,
// the popup page, and the icons, never the TypeScript sources or tooling.
export default {
  ignoreFiles: [
    "src/**",
    "scripts/**",
    ".github/**",
    ".claude/**",
    "docs/**",
    "testpage/**",
    "node_modules/**",
    "icons/*-512.png",
    "build.mjs",
    "tsconfig.json",
    "package.json",
    "package-lock.json",
    "web-ext-config.mjs",
    "README.md",
    "updates.json",
  ],
};

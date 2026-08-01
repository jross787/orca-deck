import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import path from "node:path";
import url from "node:url";

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "dev.onorca.agent-deck.sdPlugin";

/** @type {import('rollup').RollupOptions} */
const config = {
  input: "plugin/src/plugin.ts",
  output: {
    file: `${sdPlugin}/bin/plugin.js`,
    sourcemap: isWatching,
    sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
      return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
    },
  },
  plugins: [
    {
      name: "watch-externals",
      buildStart() {
        this.addWatchFile(`${sdPlugin}/manifest.json`);
      },
    },
    typescript({
      tsconfig: "./tsconfig.json",
      compilerOptions: {
        module: "ES2022",
        moduleResolution: "Bundler",
        declaration: false,
        declarationMap: false,
        sourceMap: isWatching,
        outDir: undefined,
        rootDir: undefined,
      },
      exclude: ["tests/**", "scripts/**", "dist/**", "node_modules/**"],
    }),
    nodeResolve({
      browser: false,
      exportConditions: ["node"],
      preferBuiltins: true,
    }),
    commonjs(),
    !isWatching && terser(),
    {
      name: "emit-module-package-file",
      generateBundle() {
        this.emitFile({
          fileName: "package.json",
          source: `{ "type": "module" }\n`,
          type: "asset",
        });
      },
    },
  ],
};

export default config;

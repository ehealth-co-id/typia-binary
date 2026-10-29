#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import manifest from "../package.json" with { type: "json" };
import { create } from 'mutative'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = (...segments: string[]) => path.join(root, ...segments);

const { out, packageName, packageVersion, platforms } = await yargs(process.argv)
	.env("TYPIA_BUILD")
	.option("package-name", {
		type: "string",
		default: "typia-binary",
	})
	.option("package-version", {
		type: "string",
		default: manifest.version,
	})
	.option("platforms", {
		type: "string",
		default: manifest.typiaBinary.platforms.join(","),
	})
	.option("out", {
		alias: "o",
		type: "string",
		default: p("dist-umbrella"),
		description: "Output directory",
	})
	.parseAsync();

const supported = String(platforms).split(/[\s,]+/).filter(Boolean);
if (!supported.length) throw new Error("no platforms given");
if (out === root || out.startsWith(p("package") + path.sep)) throw new Error(`Refusing to clean ${out}`);

await fs.rm(out, { force: true, recursive: true });
await fs.cp(p("package", "bin"), path.join(out, "bin"), { recursive: true });
await fs.cp(p("package", "lib"), path.join(out, "lib"), { recursive: true });
await fs.cp(p("README.md"), path.join(out, "README.md"));
await fs.writeFile(
	path.join(out, "package.json"),
	JSON.stringify(
		create(manifest, draft => {
			draft.name = packageName;
			draft.version = packageVersion;

			draft.bin = {
				"typia-binary": "bin/typia-binary.mjs",
			};

			// No plugins/ and no build.json: those live in the platform package
			// that optionalDependencies below pulls in.
			draft.files = [
				"bin",
				"lib",
				"package.json",
				"README.md",
			] as never[];

			// @ts-expect-error
			delete draft.engines.node;

			// Wholesale, not `delete draft.scripts.build`: otherwise every other factory script
			// leaks into the published manifest pointing at files that are not in `files`.
			// @ts-expect-error
			draft.scripts = { postinstall: "node bin/typia-binary.mjs install" };


			// @ts-expect-error
			draft.dependencies = {};
			// Needed only by the `npm install` below, which must fetch the toolchain it
			// compiles against. npm never installs a dependency's devDependencies.
			// @ts-expect-error
			draft.devDependencies = {};

			// No os/cpu here on purpose: a top-level package with a non-matching `os` fails
			// the install outright, and an unsupported platform must still install and then
			// cold-build. No plugins/ and no build.json either — the platform packages have
			// those.
			// @ts-expect-error
			draft.optionalDependencies = Object.fromEntries(
				supported.map(platform => [`${packageName}-${platform}`, packageVersion]),
			)
		}),
		null,
		'\t',
	),
	{ encoding: "utf-8", flag: "w" },
);

console.log(
	`umbrella ${packageName}@${packageVersion} -> ${supported.map(platform => `${packageName}-${platform}`).join(", ")}`,
);

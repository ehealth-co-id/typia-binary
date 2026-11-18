#!/usr/bin/env node
import { create } from "mutative";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import manifest from "../package.json" with { type: "json" };

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = (...segments: string[]) => path.join(root, ...segments);

const BINARY = process.platform === "win32" ? "plugin.exe" : "plugin";
const DEFAULT_PACKAGE_NAME = "@ehealth-co-id/typia-binary";

const {
	from: seed,
	out,
	packageName,
	packageVersion,
	platforms,
	buildVersionTtsc,
	buildVersionTypescript,
	buildVersionTypia,
} = await yargs(
	process.argv,
)
	.env("BINARY_BUILD")
	.option("build-version-ttsc", { type: "string", default: manifest.typiaBinary.build.ttsc })
	.option("build-version-typescript", { type: "string", default: manifest.typiaBinary.build.typescript })
	.option("build-version-typia", { type: "string", default: manifest.typiaBinary.build.typia })
	.option("package-name", {
		type: "string",
		default: DEFAULT_PACKAGE_NAME,
		coerce: v => v || DEFAULT_PACKAGE_NAME,
	})
	.option("package-version", {
		type: "string",
		default: manifest.version,
	})
	.option("out", {
		alias: "o",
		type: "string",
		default: p("dist"),
		description: "Output directory",
	})
	.option("from", {
		alias: "seed",
		type: "string",
		description: "Seed plugins from a warm cache dir instead of compiling",
	})
	.option("platforms", {
		type: "string",
		default: manifest.typiaBinary.platforms.join(","),
		description: "Platforms the umbrella publishes. Refuses to build one not listed",
	})
	.parseAsync();

const supported = String(platforms).split(/[\s,]+/).filter(Boolean);
const self = `${process.platform}-${process.arch}`;
if (!supported.includes(self)) {
	throw new Error(`refusing to build ${self}: not in --platforms (${supported.join(", ")})`);
}
// Validate the cheap inputs before the first expensive step, so a typo cannot cost a
// 240 MB `npm install`.
if (seed && !(await fs.stat(seed).catch(() => null))) throw new Error(`--from dir not found: ${seed}`);

if (out === root || out.startsWith(p("package") + path.sep)) throw new Error(`Refusing to clean ${out}`);
await fs.rm(out, { force: true, recursive: true });
await fs.mkdir(out, { recursive: true });
await fs.writeFile(
	path.join(out, "package.json"),
	JSON.stringify(
		create(manifest, draft => {
			draft.name = `${packageName}-${process.platform}-${process.arch}`;
			draft.version = packageVersion;

			// Artifacts only: the umbrella owns bin/lib and the postinstall that copies these.
			draft.files = [
				"plugins",
				"build.json",
				"package.json",
			] as never[];

			// @ts-expect-error
			delete draft.engines.node;

			// @ts-expect-error
			delete draft.typiaBinary;

			// @ts-expect-error
			draft.scripts = {};

			// @ts-expect-error
			draft.dependencies = {};
			// Needed only by the `npm install` below, which must fetch the toolchain it
			// compiles against. npm never installs a dependency's devDependencies.
			draft.devDependencies = {
				ttsc: buildVersionTtsc,
				typescript: buildVersionTypescript,
				typia: buildVersionTypia,
			} as never;

			// What makes npm install only the matching package from the umbrella.
			// @ts-expect-error
			draft.os = [process.platform];
			// @ts-expect-error
			draft.cpu = [process.arch];
		}),
		null,
		"\t",
	),
	{ encoding: "utf-8", flag: "w" },
);
await fs.writeFile(
	path.join(out, "tsconfig.json"),
	JSON.stringify(
		{
			"compilerOptions": {
				"strict": true,
				"plugins": [{ "transform": "typia/lib/transform" }],
			},
		},
		null,
		4,
	),
	{ encoding: "utf-8", flag: "w" },
);
let pluginKeys: string[];
if (seed) {
	const source = await fs.stat(path.join(seed, "plugins"))
			.then(v => v.isDirectory())
			.catch(() => null)
		? path.join(seed, "plugins")
		: seed;

	pluginKeys = await getPlugins(source);
	if (pluginKeys.length !== 1) {
		throw new Error(`typia plugin seed must consist of only 1 plugin key, instead got: ${JSON.stringify(pluginKeys)}`)
	}

	const key = pluginKeys[0]
	await fs.mkdir(path.join(out, "plugins"), { recursive: true });
	await fs.mkdir(path.join(out, "plugins", key), { recursive: true });
	await fs.cp(path.join(source, key, BINARY), path.join(out, "plugins", key, BINARY));
	console.log(`seeded from ${source}`);
} else {
	run("npm install", out);
	run("npx ttsc prepare --cache-dir .", out);
	pluginKeys = await getPlugins(path.join(out, "plugins"));
	if (pluginKeys.length !== 1) {
		throw new Error(`typia plugin build process produce more than 1 plugin keys: ${JSON.stringify(pluginKeys)}`)
	}
}

const meta = {
	packages: {
		typia: buildVersionTypia,
		ttsc: buildVersionTtsc,
		typescript: buildVersionTypescript,
	},
	platform: process.platform,
	arch: process.arch,
	pluginKey: pluginKeys[0],
};

await fs.writeFile(path.join(out, "build.json"), JSON.stringify(meta, null, "\t") + "\n");
console.log(`built ${meta.platform}/${meta.arch}: ${meta.pluginKey}`);

async function keysIn(dir: string) {
	return fs
		.readdir(dir, { withFileTypes: true })
		.then(dirs => {
			return Promise.all(
				dirs
					.map((entry) =>
						fs.stat(path.join(dir, entry.name, BINARY))
							.then(e => [entry, e] as const)
							.catch(() => [entry, null] as const)
					),
			)
				.then((entry) =>
					entry
						.filter(([, plugin]) => plugin?.isFile())
						.map(([dir]) => dir.name)
				);
		});
}

async function getPlugins(dir: string) {
	const keys = await keysIn(dir);
	if (!keys.length) throw new Error(`no ${BINARY} produced or found in ${dir}`);

	return keys;
}

function run(cmd: string, cwd: string) {
	try {
		execSync(cmd, { cwd, stdio: "inherit" });
	} catch (error) {
		throw new Error(`build step failed: ${cmd}`, { cause: error });
	}
}

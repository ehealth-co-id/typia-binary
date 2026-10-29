#!/usr/bin/env node
import { create } from "mutative";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import packageJson from "../package.json" with { type: "json" };

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = (...segments: string[]) => path.join(root, ...segments);

const { from: seed, out, packageName, packageVersion, buildVersionTtsc, buildVersionTypescript, buildVersionTypia } =
	await yargs(
		process.argv,
	)
		// Every option below is also readable from the environment as TYPIA_BUILD_<OPTION>
		// (TYPIA_BUILD_FROM, TYPIA_BUILD_OUT, TYPIA_BUILD_PACKAGE_VERSION,
		// TYPIA_BUILD_BUILD_VERSION_TYPIA, …). A CLI flag wins over the env var.
		.env("TYPIA_BUILD")
		.option("build-version-ttsc", { type: "string", default: "0.30.4" })
		.option("build-version-typescript", { type: "string", default: "7.0.2" })
		.option("build-version-typia", { type: "string", default: "15.0.1" })
		.option("package-name", {
			type: "string",
			default: "typia-binary",
		})
		.option("package-version", {
			type: "string",
			default: packageJson.version,
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
		.parseAsync();

if (out === root || out.startsWith(p("package") + path.sep)) throw new Error(`Refusing to clean ${out}`);
await fs.rm(out, { force: true, recursive: true });
await fs.cp(p("package"), out, { force: true, recursive: true });
await fs.writeFile(
	path.join(out, "package.json"),
	JSON.stringify(
		create(packageJson, draft => {
			draft.name = `${packageName}-${process.platform}-${process.arch}`;
			draft.version = packageVersion;

			draft.bin = {
				"typia-binary": "bin/typia-binary.mjs",
			};

			draft.files = [
				"bin",
				"lib",
				"plugins",
				"build.json",
				"package.json",
				"README.md",
			] as never[];

			// @ts-expect-error
			delete draft.engines.node;

			// @ts-expect-error
			delete draft.scripts.build;
			// @ts-expect-error
			draft.scripts.postinstall = "node bin/typia-binary.mjs install";

			draft.peerDependencies = {
				ttsc: buildVersionTtsc,
				typescript: buildVersionTypescript,
				typia: buildVersionTypia,
			};

			// @ts-expect-error
			draft.dependencies = {};
			// @ts-expect-error
			draft.devDependencies = {};
		}),
		null,
		4,
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
run("npm install", out);

let pluginKeys: string[];
if (seed) {
	const source = await fs.stat(path.join(seed, "plugins"))
			.then(v => v.isDirectory())
			.catch(() => null)
		? path.join(seed, "plugins")
		: seed;

	pluginKeys = await getPlugins(source);

	await fs.mkdir(path.join(out, "plugins"), { recursive: true });
	for (const key of pluginKeys) {
		await fs.mkdir(path.join(out, "plugins", key), { recursive: true });
		await fs.cp(path.join(source, key, "plugin"), path.join(out, "plugins", key, "plugin"));
	}
	console.log(`seeded from ${source}`);
} else {
	run("npx ttsc prepare --cache-dir .", out);
	pluginKeys = await getPlugins(path.join(out, "plugins"));
}

const meta = {
	packages: {
		typia: buildVersionTypia,
		ttsc: buildVersionTtsc,
		typescript: buildVersionTypescript,
	},
	platform: process.platform,
	arch: process.arch,
	pluginKeys,
};

await fs.writeFile(path.join(out, "build.json"), JSON.stringify(meta, null, "\t") + "\n");
console.log(`built ${meta.platform}/${meta.arch}: ${pluginKeys.join(", ")}`);

async function keysIn(dir: string) {
	return fs
		.readdir(dir, { withFileTypes: true })
		.then(dirs => {
			return Promise.all(
				dirs
					.map((entry) =>
						fs.stat(path.join(dir, entry.name, "plugin"))
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
	if (!keys.length) throw new Error("no plugin binary produced or found");

	return keys;
}

function run(cmd: string, cwd: string) {
	try {
		execSync(cmd, { cwd, stdio: "inherit" });
	} catch (error) {
		throw new Error(`build step failed: ${cmd}`, { cause: error });
	}
}

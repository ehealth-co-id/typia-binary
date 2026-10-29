import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./log.mjs";

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const pkgVersion = (name, from) => {
	let dir = from;
	while (true) {
		const file = path.join(dir, "node_modules", name, "package.json");
		if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")).version;
		const up = path.dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
};

const cacheRoot = (consumer, cacheDir) => {
	if (cacheDir) return path.resolve(consumer, cacheDir);
	if (process.env.TTSC_CACHE_DIR) return path.resolve(consumer, process.env.TTSC_CACHE_DIR);
	return path.join(consumer, "node_modules", ".cache", "ttsc");
};

export const install = ({ quiet = false, force = false, cacheDir } = {}) => {
	const Console = logger(quiet);

	// Absent in a source checkout that has not been built yet; nothing to install then.
	if (!fs.existsSync(path.join(pkgRoot, "build.json"))) return false;
	const meta = JSON.parse(fs.readFileSync(path.join(pkgRoot, "build.json"), "utf8"));
	// npm/yarn set INIT_CWD; ttsc resolves its cache root from the workspace root, which is what this is.
	const consumer = process.env.INIT_CWD || process.cwd();

	const stale = [];
	if (meta.platform !== process.platform || meta.arch !== process.arch) {
		stale.push(`built for ${meta.platform}/${meta.arch}, this machine is ${process.platform}/${process.arch}`);
	}

	for (const [name, version] of Object.entries(meta.packages)) {
		const have = pkgVersion(name, consumer);
		if (have !== null && have !== version) stale.push(`${name} ${have} installed, ${version} in cache`);
	}

	if (stale.length) {
		Console.warn("typia-binary: cache does not match this project!");
		for (const line of stale) Console.warn(`  - ${line}`);
		throw new Error("Project must install the exact combination of the dependencies!");
	}

	const src = path.join(pkgRoot, "plugins");
	const dest = path.join(cacheRoot(consumer, cacheDir), "plugins");
	const keys = meta.keys.filter((key) => fs.existsSync(path.join(src, key, "plugin")));
	const todo = keys.filter((key) => force || !fs.existsSync(path.join(dest, key, "plugin")));

	if (!todo.length) {
		Console.log(`typia-binary: cache already warm at ${dest}`);
		return true;
	}

	fs.mkdirSync(dest, { recursive: true });
	for (const key of todo) fs.cpSync(path.join(src, key), path.join(dest, key), { recursive: true });

	Console.log(
		`typia-binary: warmed ${todo.length} plugin binary (typia ${meta.packages.typia}, ttsc ${meta.packages.ttsc}) into ${dest}`,
	);

	return true;
};

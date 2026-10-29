import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./log.mjs";

const require = createRequire(import.meta.url);
const ownRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// The umbrella ships no binaries: npm installs whichever of its os/cpu-matched
// optionalDependencies resolve on this machine. A platform package installed on its own
// still works, because then its own root is the one holding build.json.
const artifactRoot = () => {
	const roots = [ownRoot];
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(ownRoot, "package.json"), "utf8"));
		for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
			try {
				roots.push(path.dirname(require.resolve(`${name}/package.json`)));
			} catch {
				// not installed for this platform
			}
		}
	} catch {
		// unreadable own manifest: ownRoot is all we can offer
	}
	return roots.find((dir) => fs.existsSync(path.join(dir, "build.json"))) ?? null;
};

const pkgVersion = (name, from) => {
	let dir = from;
	while (true) {
		const file = path.join(dir, "node_modules", name, "package.json");
		if (fs.existsSync(file)) {
			try {
				return JSON.parse(fs.readFileSync(file, "utf8")).version;
			} catch {
				return null;
			}
		}
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

// ttsc writes `plugin.exe` on Windows, `plugin` everywhere else.
const binaryName = process.platform === "win32" ? "plugin.exe" : "plugin";

export const install = ({ quiet = false, force = false, cacheDir } = {}) => {
	const Console = logger(quiet);

	// Null on an unsupported platform, under --omit=optional, or in a source checkout that
	// has not been built yet; ttsc cold-builds exactly as it would without us.
	const root = artifactRoot();
	if (root === null) {
		Console.log(`typia-binary: no prebuilt plugin for ${process.platform}/${process.arch}; ttsc will build it`);
		return false;
	}
	let meta;
	try {
		meta = JSON.parse(fs.readFileSync(path.join(root, "build.json"), "utf8"));
	} catch {
		Console.warn("typia-binary: build.json is unreadable; skipping cache warm");
		return false;
	}
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

	const src = path.join(root, "plugins");
	const dest = path.join(cacheRoot(consumer, cacheDir), "plugins");
	const keys = meta.keys.filter((key) => fs.existsSync(path.join(src, key, binaryName)));
	const todo = keys.filter((key) => force || !fs.existsSync(path.join(dest, key, binaryName)));

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

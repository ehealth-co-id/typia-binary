import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// Constants mirrored from ttsc/src/plugin/internal/buildSourcePlugin.ts (0.30.x); ttsc
// does not export either of them.
const GO_MOD_SEARCH_MAX_DEPTH = 3;
const PRUNE_DIRS = new Set(["node_modules", ".git", ".ttsc"]);

/**
 * Work out the cache key ttsc will look up for `pluginPackage`'s source plugin in
 * `consumer`, so the shipped binary can be placed where ttsc checks.
 *
 * Why this exists: ttsc's key hashes build-environment inputs alongside the
 * versions — `AR` and `GCCGO` are hashed as `value + sha256(the executable)`,
 * plus `GOROOT` content and any set `GOFLAGS`/`CGO_ENABLED`/`LD_LIBRARY_PATH`/…
 * So a binary published from a runner is keyed to *that runner's* toolchain and
 * never matches a consumer whose binutils revision differs. The shipped key is
 * therefore meaningless here; only the versions (checked by the caller) and the
 * platform matter for correctness, and the binary is static.
 *
 * Every step below mirrors what ttsc itself assembles. If ttsc changes any of
 * it, the key stops matching and ttsc cold-builds — exactly what happens today
 * without this file. Never throws.
 *
 * @returns {{ key: string | null, reason: string }}
 */
export function resolvePluginCacheKey({ consumer, pluginPackage = "typia" }) {
	try {
		return { key: computePluginCacheKey(consumer, pluginPackage), reason: "ok" };
	} catch (error) {
		// first line only: a require-stack trace would wrap the install log
		return { key: null, reason: String(error instanceof Error ? error.message : error).split("\n")[0] };
	}
}

function computePluginCacheKey(consumer, pluginPackage) {
	const req = createRequire(path.join(consumer, "package.json"));
	const ttscRoot = path.dirname(req.resolve("ttsc/package.json"));
	// `ttsc`'s `exports` map allows only `.`, `./register`, `./path-identity` and
	// `./package.json`, so internals are loaded by absolute path. Reuse ttsc's own
	// exports wherever they exist instead of mirroring them:
	//   plugin/internal/buildSourcePlugin.js -> the hashing itself
	//   compiler/internal/paths.js           -> findNearestGoMod
	const { computeCacheKey } = req(path.join(ttscRoot, "lib", "plugin", "internal", "buildSourcePlugin.js"));
	if (typeof computeCacheKey !== "function") throw new Error("ttsc does not export computeCacheKey");
	const { findNearestGoMod } = req(path.join(ttscRoot, "lib", "compiler", "internal", "paths.js"));
	if (typeof findNearestGoMod !== "function") throw new Error("ttsc does not export findNearestGoMod");

	const descriptor = loadPluginDescriptor(req, consumer, pluginPackage);
	const source = fs.realpathSync(
		path.isAbsolute(descriptor.source) ? descriptor.source : path.resolve(consumer, descriptor.source),
	);

	// resolveSourceBuildTarget: the Go module dir, and the entry relative to it.
	const goMod = findNearestGoMod(source, GO_MOD_SEARCH_MAX_DEPTH);
	if (goMod === null) throw new Error(`no go.mod within ${GO_MOD_SEARCH_MAX_DEPTH} levels of ${source}`);
	const dir = path.dirname(goMod);
	const relative = path.relative(dir, source).replace(/\\/g, "/");

	// resolveGoCompiler
	let goBinary = "go";
	try {
		goBinary =
			process.env.TTSC_GO_BINARY ||
			req.resolve(`@ttsc/${process.platform}-${process.arch}/bin/go/bin/${process.platform === "win32" ? "go.exe" : "go"}`);
	} catch {
		// no bundled toolchain: ttsc falls back to PATH too
	}

	return computeCacheKey({
		contributors: descriptor.contributors ?? [],
		dir,
		entry: relative === "" ? "." : `./${relative}`,
		env: process.env,
		goBinary,
		overlayDirs: collectOverlayDirs(ttscRoot),
		ttscVersion: readVersion(path.join(ttscRoot, "package.json")) ?? "0.0.0",
		// readTsgoVersion: the version the *consumer* resolves.
		tsgoVersion: resolveTsgoVersion(req),
	});
}

/**
 * ttsc resolves the descriptor through the plugin entry and calls the exported
 * factory with a project context: `mod.createTtscPlugin ?? mod.default ??
 * mod.plugin ?? mod`, then `typeof candidate === "function" ? candidate(context)
 * : candidate`.
 */
function loadPluginDescriptor(req, consumer, pluginPackage) {
	const pluginRoot = path.dirname(req.resolve(`${pluginPackage}/package.json`));
	const manifest = readJson(path.join(pluginRoot, "package.json"), `${pluginPackage}'s package.json`);
	const transform = manifest.ttsc?.plugin?.transform ?? `${pluginPackage}/lib/transform`;
	const filename = req.resolve(transform);
	const mod = req(filename);
	const candidate = mod.createTtscPlugin ?? mod.default ?? mod.plugin ?? mod;
	const descriptor = typeof candidate === "function"
		? candidate({
			binary: ttscHelperBinary(req),
			cwd: consumer,
			dirname: path.dirname(filename),
			filename,
			plugin: manifest.ttsc?.plugin ?? {},
			projectRoot: consumer,
		})
		: candidate;
	if (descriptor === null || typeof descriptor !== "object" || typeof descriptor.source !== "string") {
		throw new Error(`${pluginPackage} returned no usable plugin source`);
	}
	return descriptor;
}

function ttscHelperBinary(req) {
	try {
		return req.resolve(`@ttsc/${process.platform}-${process.arch}/bin/ttsc`);
	} catch {
		return process.execPath;
	}
}

/** findTtscOverlayDirs: ttsc's own go.mod plus every go.mod under shim/. */
function collectOverlayDirs(ttscRoot) {
	const dirs = [];
	if (fs.existsSync(path.join(ttscRoot, "go.mod"))) dirs.push(ttscRoot);
	const shimRoot = path.join(ttscRoot, "shim");
	if (fs.existsSync(shimRoot)) walkForGoMod(shimRoot, dirs);
	dirs.sort();
	return dirs;
}

function walkForGoMod(root, out) {
	let entries;
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	if (entries.some((entry) => entry.isFile() && entry.name === "go.mod")) out.push(root);
	for (const entry of entries) {
		if (!entry.isDirectory() || PRUNE_DIRS.has(entry.name)) continue;
		walkForGoMod(path.join(root, entry.name), out);
	}
}

/** readTsgoVersion: the `typescript` package the consumer resolves. */
function resolveTsgoVersion(req) {
	try {
		return readVersion(req.resolve("typescript/package.json")) ?? "unknown";
	} catch {
		return "unknown";
	}
}

function readJson(file, what) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		throw new Error(`cannot read ${what} at ${file}`);
	}
}

function readVersion(manifest) {
	try {
		const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
		return typeof parsed.version === "string" ? parsed.version : null;
	} catch {
		return null;
	}
}

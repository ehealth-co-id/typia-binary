#!/usr/bin/env node
import { install } from "../lib/install.mjs";

const args = process.argv.slice(2);
if (args[0] === "install") args.shift();
const flag = (name) => {
	const at = args.indexOf(name);
	return at < 0 ? undefined : args[at + 1];
};

install({
	quiet: args.includes("--quiet"),
	force: args.includes("--force"),
	cacheDir: flag("--cache-dir"),
});

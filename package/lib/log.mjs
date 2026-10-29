export function logger(quiet = false) {
	return new Proxy(console, {
		get(t, p) {
			const r = t[p];
			if (typeof r === "function" && quiet) return () => {};
			return r;
		},
	});
}

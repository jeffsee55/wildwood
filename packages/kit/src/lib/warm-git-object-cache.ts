import { getGitObjectCache, type TreeEntries } from "tr33-store";

function normalizeApiBase(base: string): string {
	const b = (base.trim() || "/api").replace(/\/+$/, "");
	return b.startsWith("/") ? b : `/${b}`;
}

/** Prefetch worktree trees into same-origin IndexedDB before the editor iframe loads. */
export async function warmGitObjectCache(args: {
	origin: string;
	apiBase: string;
	repo: string;
	ref: string;
}): Promise<void> {
	if (typeof window === "undefined") return;

	const cache = getGitObjectCache();
	const gitBase = `${args.origin}${normalizeApiBase(args.apiBase)}/git`;

	const wtRes = await fetch(
		`${gitBase}/worktrees/${encodeURIComponent(args.ref)}`,
		{ credentials: "include" },
	);
	if (!wtRes.ok) return;

	const wt = (await wtRes.json()) as {
		rootTreeOid?: string | null;
		commit?: { treeOid?: string };
	};
	const rootOid = wt.rootTreeOid ?? wt.commit?.treeOid;
	const commitTreeOid = wt.commit?.treeOid;
	if (!rootOid) return;

	const queue: string[] = [rootOid];
	if (commitTreeOid && commitTreeOid !== rootOid) {
		queue.push(commitTreeOid);
	}
	const seen = new Set<string>();

	while (queue.length > 0) {
		const oid = queue.shift()!;
		if (seen.has(oid)) continue;
		seen.add(oid);

		const tree = await cache.fetchTree(args.repo, oid, async () => {
			const res = await fetch(`${gitBase}/tree/${encodeURIComponent(oid)}`, {
				credentials: "include",
			});
			if (!res.ok) return null;
			return (await res.json()) as TreeEntries;
		});
		if (!tree) continue;

		for (const entry of Object.values(tree)) {
			if (entry.type === "tree") {
				queue.push(entry.oid);
			}
		}
	}
}

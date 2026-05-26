import type { TreeEntries } from "./types";

const DB_NAME = "tr33-git-cache";
const DB_VERSION = 1;
const TREES_STORE = "trees";
const BLOBS_STORE = "blobs";

export function gitObjectCacheKey(repo: string, oid: string): string {
	return `${repo.toLowerCase()}:${oid}`;
}

function uint8ToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]!);
	}
	return btoa(binary);
}

function base64ToUint8(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

type TreeRecord = {
	id: string;
	repo: string;
	oid: string;
	entries: TreeEntries;
	updatedAt: number;
};

type BlobRecord = {
	id: string;
	repo: string;
	oid: string;
	base64: string;
	updatedAt: number;
};

let shared: GitObjectCache | null = null;

export function getGitObjectCache(): GitObjectCache {
	if (!shared) {
		shared = new GitObjectCache();
	}
	return shared;
}

export class GitObjectCache {
	private dbPromise: Promise<IDBDatabase | null> | null = null;
	private treeMem = new Map<string, TreeEntries>();
	private blobMem = new Map<string, Uint8Array>();
	private treeInflight = new Map<string, Promise<TreeEntries | null>>();
	private blobInflight = new Map<string, Promise<Uint8Array | null>>();

	private openDb(): Promise<IDBDatabase | null> {
		if (typeof indexedDB === "undefined") {
			return Promise.resolve(null);
		}
		if (!this.dbPromise) {
			this.dbPromise = new Promise((resolve, reject) => {
				const req = indexedDB.open(DB_NAME, DB_VERSION);
				req.onupgradeneeded = () => {
					const db = req.result;
					if (!db.objectStoreNames.contains(TREES_STORE)) {
						db.createObjectStore(TREES_STORE, { keyPath: "id" });
					}
					if (!db.objectStoreNames.contains(BLOBS_STORE)) {
						db.createObjectStore(BLOBS_STORE, { keyPath: "id" });
					}
				};
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
			}).catch(() => null);
		}
		return this.dbPromise;
	}

	private readRecord<T>(storeName: string, id: string): Promise<T | null> {
		return this.openDb().then((db) => {
			if (!db) return null;
			return new Promise<T | null>((resolve, reject) => {
				const tx = db.transaction(storeName, "readonly");
				const req = tx.objectStore(storeName).get(id);
				req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
				req.onerror = () => reject(req.error ?? new Error("IndexedDB read failed"));
			});
		});
	}

	private writeRecord(storeName: string, record: unknown): Promise<void> {
		return this.openDb().then((db) => {
			if (!db) return;
			return new Promise<void>((resolve, reject) => {
				const tx = db.transaction(storeName, "readwrite");
				tx.objectStore(storeName).put(record);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
			});
		});
	}

	async hasTree(repo: string, oid: string): Promise<boolean> {
		const key = gitObjectCacheKey(repo, oid);
		if (this.treeMem.has(key)) return true;
		const record = await this.readRecord<TreeRecord>(TREES_STORE, key);
		return record != null;
	}

	async getTree(repo: string, oid: string): Promise<TreeEntries | null> {
		const key = gitObjectCacheKey(repo, oid);
		const mem = this.treeMem.get(key);
		if (mem) return mem;

		const record = await this.readRecord<TreeRecord>(TREES_STORE, key);
		if (!record) return null;
		this.treeMem.set(key, record.entries);
		return record.entries;
	}

	async putTree(repo: string, oid: string, entries: TreeEntries): Promise<void> {
		const key = gitObjectCacheKey(repo, oid);
		this.treeMem.set(key, entries);
		await this.writeRecord(TREES_STORE, {
			id: key,
			repo: repo.toLowerCase(),
			oid,
			entries,
			updatedAt: Date.now(),
		} satisfies TreeRecord);
	}

	async fetchTree(
		repo: string,
		oid: string,
		fetcher: () => Promise<TreeEntries | null>,
	): Promise<TreeEntries | null> {
		const cached = await this.getTree(repo, oid);
		if (cached) return cached;

		const key = gitObjectCacheKey(repo, oid);
		const inflight = this.treeInflight.get(key);
		if (inflight) return inflight;

		const promise = (async () => {
			const tree = await fetcher();
			if (tree) {
				await this.putTree(repo, oid, tree);
			}
			return tree;
		})().finally(() => {
			this.treeInflight.delete(key);
		});
		this.treeInflight.set(key, promise);
		return promise;
	}

	async getBlobRaw(repo: string, oid: string): Promise<Uint8Array | null> {
		const key = gitObjectCacheKey(repo, oid);
		const mem = this.blobMem.get(key);
		if (mem) return mem;

		const record = await this.readRecord<BlobRecord>(BLOBS_STORE, key);
		if (!record) return null;
		const bytes = base64ToUint8(record.base64);
		this.blobMem.set(key, bytes);
		return bytes;
	}

	async putBlobRaw(
		repo: string,
		oid: string,
		bytes: Uint8Array,
	): Promise<void> {
		const key = gitObjectCacheKey(repo, oid);
		this.blobMem.set(key, bytes);
		await this.writeRecord(BLOBS_STORE, {
			id: key,
			repo: repo.toLowerCase(),
			oid,
			base64: uint8ToBase64(bytes),
			updatedAt: Date.now(),
		} satisfies BlobRecord);
	}

	async fetchBlobRaw(
		repo: string,
		oid: string,
		fetcher: () => Promise<Uint8Array | null>,
	): Promise<Uint8Array | null> {
		const cached = await this.getBlobRaw(repo, oid);
		if (cached) return cached;

		const key = gitObjectCacheKey(repo, oid);
		const inflight = this.blobInflight.get(key);
		if (inflight) return inflight;

		const promise = (async () => {
			const bytes = await fetcher();
			if (bytes) {
				await this.putBlobRaw(repo, oid, bytes);
			}
			return bytes;
		})().finally(() => {
			this.blobInflight.delete(key);
		});
		this.blobInflight.set(key, promise);
		return promise;
	}

	/** Warm in-memory `Trees.treeStore` from IndexedDB for a root OID (BFS, cache hits only). */
	async seedTreeStore(args: {
		repo: string;
		rootOid: string;
		treeStore: Map<string, TreeEntries>;
		maxNodes?: number;
	}): Promise<number> {
		const maxNodes = args.maxNodes ?? 512;
		const queue = [args.rootOid];
		const seen = new Set<string>();
		let loaded = 0;

		while (queue.length > 0 && loaded < maxNodes) {
			const oid = queue.shift()!;
			if (seen.has(oid)) continue;
			seen.add(oid);

			const tree = await this.getTree(args.repo, oid);
			if (!tree) continue;

			if (!args.treeStore.has(oid)) {
				args.treeStore.set(oid, tree);
				loaded++;
			}
			for (const entry of Object.values(tree)) {
				if (entry.type === "tree") {
					queue.push(entry.oid);
				}
			}
		}
		return loaded;
	}
}

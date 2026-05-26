export type {
	TreeEntries,
	TreeStore,
	CommitAuthor,
	CommitNode,
} from "./types";

export {
	type Gitable,
	type LookupResult,
	type ResolveResult,
	type Diff2Entry,
	type DiffEntry,
	type DiffTreesConflict,
	type NewBlob,
	type ApplyTreesResult,
	type DiffTreesResult,
	Trees,
} from "./trees";

export {
	GitObjectCache,
	getGitObjectCache,
	gitObjectCacheKey,
} from "./git-object-cache";

export {
	calculateBlobOid,
	calculateBlobOidFromBytes,
	calculateCommitOid,
	calculateTreeOid,
} from "./git-objects";

export {
	type ContentMergeResult,
	type GetBlobFn,
	type GetEntriesFn,
	type MergeConflict,
	type MergeOrtResult,
	type MergeResult,
	type PathEntry,
	type TreeDiff,
	tryContentMerge,
	mergeOrt,
} from "./merge";

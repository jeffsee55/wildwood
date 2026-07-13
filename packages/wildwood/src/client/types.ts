import { z } from "zod/v4";
import type { AnyCollection } from "@/client/config";
import type { WhereClause, WithClause } from "@/types";

// ── primitives ───────────────────────────────────────────────────────────

export type StringQueryType = z.infer<typeof QuerySchema>;

const QuerySchema = z
  .object({
    eq: z.string().optional(),
    ne: z.string().optional(),
    gt: z.string().optional(),
    gte: z.string().optional(),
    lt: z.string().optional(),
    lte: z.string().optional(),
    in: z.string().array().optional(),
    notIn: z.string().array().optional(),
    like: z.string().optional(),
    ilike: z.string().optional(),
    notLike: z.string().optional(),
    notIlike: z.string().optional(),
    isNull: z.boolean().optional(),
    isNotNull: z.boolean().optional(),
    get OR(): z.ZodLazy<z.ZodOptional<z.ZodArray<typeof QuerySchema>>> {
      return z.lazy(() => z.array(QuerySchema).optional());
    },
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), {
    message: "At least one query condition must be specified.",
  });

// ── helpers ──────────────────────────────────────────────────────────────

type MaybePrefix<P extends string> = P extends "" ? "" : `${P}.`;
type Inc<N extends number> = N extends 0 ? 1 : N extends 1 ? 2 : N extends 2 ? 3 : 4;
type Prettify<T> = { [K in keyof T]: T[K] } & {};

type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (k: infer I) => void
  ? I
  : never;

/** Unwrap `z.codec(in, out)` or `z.coerce`/pipe wrappers to get the output object type.
 *  Crucially we handle multiple layers: `z.codec` is itself a `ZodPipe`,
 *  and `markdown` returns `codec(string, object)`. We unwrap recursively.
 */
type UnwrapCodec<T> =
  T extends z.ZodCodec<infer _I, infer O extends z.core.$ZodType>
    ? UnwrapCodec<O>
    : T extends { def: { out: infer O } }
      ? O extends z.core.$ZodType
        ? UnwrapCodec<O>
        : O
      : T extends { _zod: { def: { out: infer O } } }
        ? O extends z.core.$ZodType
          ? UnwrapCodec<O>
          : O
        : T;

// ── FindTypes – collect filter & connection markers from a Zod schema ───

export type FindTypes<T extends z.core.$ZodType, Cur extends string = ""> =
  T extends z.ZodObject<infer S>
    ? { [K in keyof S]: FindTypes<S[K], `${MaybePrefix<Cur>}${K & string}`> }[keyof S]
    : T extends z.ZodArray<infer U extends z.core.$ZodType>
      ? FindTypes<U, Cur>
      : T extends z.ZodLazy<infer U extends z.core.$ZodType>
        ? FindTypes<U, Cur>
        : T extends z.ZodOptional<infer U extends z.core.$ZodType>
          ? FindTypes<U, Cur>
          : T extends z.ZodNullable<infer U extends z.core.$ZodType>
            ? FindTypes<U, Cur>
            : T extends z.ZodDefault<infer U extends z.core.$ZodType>
              ? FindTypes<U, Cur>
              : T extends z.ZodPipe<infer _I extends z.ZodType, infer O extends z.core.$ZodType>
                ? FindTypes<O, Cur>
                : T extends z.ZodUnion<infer Opts extends readonly z.core.$ZodType[]>
                  ? { [K in keyof Opts]: FindTypes<Opts[K], WithDisc<Cur, Opts[K]>> }[number]
                  : T extends z.ZodIntersection<
                        infer A extends z.core.$ZodType,
                        infer B extends z.core.$ZodType
                      >
                    ? FindTypes<A, Cur> | FindTypes<B, Cur>
                    : T extends z.ZodCustom<infer Out, infer In>
                      ? In extends { __internalFilter: infer FT }
                        ? { type: "filter"; value: FT; path: Cur }
                        : Out extends { _collection: infer Coll extends string }
                          ? Out extends { _referencedAs: infer RA extends string }
                            ? { type: "connection"; value: Coll; path: Cur; referencedAs: RA }
                            : { type: "connection"; value: Coll; path: Cur }
                          : Out extends { _collection: string }
                            ? In extends z.ZodObject<infer IS>
                              ? IS extends { _referencedAs: z.ZodLiteral<infer RA extends string> }
                                ? {
                                    type: "connection";
                                    value: Out extends { _collection: infer C extends string }
                                      ? C
                                      : string;
                                    path: Cur;
                                    referencedAs: RA;
                                  }
                                : {
                                    type: "connection";
                                    value: Out extends { _collection: infer C extends string }
                                      ? C
                                      : string;
                                    path: Cur;
                                  }
                              : {
                                  type: "connection";
                                  value: Out extends { _collection: infer C extends string }
                                    ? C
                                    : string;
                                  path: Cur;
                                }
                            : never
                      : never;

type WithDisc<P extends string, T extends z.core.$ZodType> =
  T extends z.ZodObject<infer S>
    ? {
        [K in keyof S]: S[K] extends z.ZodLiteral<infer L>
          ? `${MaybePrefix<P>}${L & string}`
          : never;
      }[keyof S]
    : T extends z.ZodCustom<infer Out>
      ? Out extends { _collection: infer C extends string }
        ? `${MaybePrefix<P>}${C}`
        : never
      : P;

type CollSchema<C> = C extends { schema: infer S }
  ? S extends z.core.$ZodType
    ? S
    : never
  : never;

export type OptionsForColl<T extends AnyCollection> = FindTypes<
  UnwrapCodec<CollSchema<T>> & z.core.$ZodType
>;

// ── connection / filter maps ─────────────────────────────────────────────

type ConnEntryBase = { type: "connection"; path: string; value: string; referencedAs?: string };
type FiltEntry = { type: "filter"; path: string; value: unknown };

type ConnMap = Record<string, ConnEntryBase>;
type FiltMap = Record<string, FiltEntry>;

// ── forward `with` ───────────────────────────────────────────────────────

type ConnArgs<
  CM extends ConnMap,
  FM extends FiltMap,
  CName extends string,
  D extends number = 0,
> = D extends 4
  ? {}
  : CName extends keyof CM
    ? Prettify<
        UnionToIntersection<
          CM[CName] extends { path: infer P extends string; value: infer V extends string }
            ? { [K in P]?: boolean | WithShape<CM, FM, V, Inc<D>> }
            : {}
        >
      >
    : {};

type WithShape<CM extends ConnMap, FM extends FiltMap, V extends string, D extends number = 0> = {
  where?: Filters<FM, V, CM> | WhereClause;
  limit?: number;
  offset?: number;
  orderBy?: Record<string, "asc" | "desc">;
  with?: ConnArgs<CM, FM, V, D>;
  references?: ReverseConns<CM, FM, V, D>;
};

// ── reverse `references` ─────────────────────────────────────────────────

type ReverseSources<CM extends ConnMap, Target extends string, RA extends string> = {
  [Src in keyof CM & string]: CM[Src] extends infer E
    ? E extends any
      ? E extends { value: Target; referencedAs: RA }
        ? Src
        : never
      : never
    : never;
}[keyof CM & string];

type ReverseConns<
  CM extends ConnMap,
  FM extends FiltMap,
  K extends string,
  D extends number = 0,
> = D extends 4
  ? Record<string, WithClause | boolean>
  : keyof ReverseEntries<CM, K> extends never
    ? Record<string, WithClause | boolean>
    : Prettify<
        {
          [RA in keyof ReverseEntries<CM, K> & string]?:
            | boolean
            | WithShape<CM, FM, ReverseEntries<CM, K>[RA] & string, Inc<D>>;
        } & Record<string, WithClause | boolean>
      >;

type ReverseEntries<CM extends ConnMap, K extends string> = {
  [Src in keyof CM & string as CM[Src] extends infer E
    ? E extends any
      ? E extends { value: K; referencedAs: infer RA extends string }
        ? RA
        : never
      : never
    : never]: Src;
};

// ── filters ──────────────────────────────────────────────────────────────

type StringOrFilter = string | StringFiltersObj;
type SystemFilters = { path?: StringOrFilter; slug?: StringOrFilter; ref?: StringOrFilter };

// Split into two layers so CM join does not get intersected into readonly index signature incorrectly.
type DirectFilters<FM extends FiltMap, K extends string> = Prettify<
  {
    [E in FM[K & keyof FM] as E extends { path: infer P extends string } ? P : never]?: E extends {
      value: infer _V;
    }
      ? StringFiltersObj
      : never;
  } & SystemFilters
>;

type JoinFilters<CM extends ConnMap, FM extends FiltMap, K extends string> = [K] extends [keyof CM]
  ? [CM[K]] extends [never]
    ? {}
    : UnionToIntersection<
        CM[K] extends { path: infer P extends string; value: infer V extends string }
          ? { [KK in P]?: V extends string ? Filters<FM, V, CM> : never }
          : {}
      >
  : {};

export type Filters<FM extends FiltMap, K extends string, CM extends ConnMap> = Prettify<
  DirectFilters<FM, K> &
    JoinFilters<CM, FM, K> & { AND?: Filters<FM, K, CM>[]; OR?: Filters<FM, K, CM>[] }
>;

type StringFiltersObj = StringQueryType;

// ── ResultType – schema + forward `with` → enriched output ───────────────

type InferRes<T extends z.core.$ZodType, W extends object> =
  ResType<T, W> extends z.core.$ZodType<infer O> ? O : never;

type ResType<T extends z.core.$ZodType, W extends object, Cur extends string = ""> =
  T extends z.ZodObject<infer S, infer Cfg>
    ? z.ZodObject<{ [K in keyof S]: ResType<S[K], W, `${MaybePrefix<Cur>}${K & string}`> }, Cfg>
    : T extends z.ZodPipe<infer I extends z.ZodType, infer O extends z.core.$ZodType>
      ? z.ZodPipe<I, ResType<O, W, Cur>>
      : T extends z.ZodArray<infer U extends z.core.$ZodType>
        ? z.ZodArray<ResType<U, W, Cur>>
        : T extends z.ZodLazy<infer U extends z.core.$ZodType>
          ? z.ZodLazy<ResType<U, W, Cur>>
          : T extends z.ZodUnion<infer Opts extends readonly z.core.$ZodType[]>
            ? z.ZodUnion<{ [K in keyof Opts]: ResType<Opts[K], W, WithDisc<Cur, Opts[K]>> }>
            : T extends z.ZodOptional<infer U extends z.core.$ZodType>
              ? z.ZodOptional<ResType<U, W, Cur>>
              : T extends z.ZodNullable<infer U extends z.core.$ZodType>
                ? z.ZodNullable<ResType<U, W, Cur>>
                : T extends z.ZodCustom<infer Out, infer In>
                  ? Cur extends keyof W
                    ? W[Cur] extends false
                      ? T
                      : In extends z.core.$ZodType
                        ? ResType<In, ExtractWith<W, Cur>>
                        : never
                    : Out extends z.core.$ZodType
                      ? Out
                      : T
                  : T;

type ExtractWith<W, P extends string> = P extends keyof W
  ? W[P] extends { with: infer NW extends object }
    ? NW
    : W[P] extends true
      ? {}
      : W[P] extends object
        ? {}
        : {}
  : {};

// ── system meta appended at runtime by Config.buildEntry ────────────

export type EntrySystemFields = {
  _meta: {
    raw: string;
    oid: string;
    path: string;
    canonicalPath: string;
    slug: string;
  };
  _collection: string;
  slug: string;
  path: string;
};

// ── reverse result typing ────────────────────────────────────────────────

type GetReverseWith<R, P extends PropertyKey> = P extends keyof R
  ? R[P] extends { with: infer W extends object }
    ? W
    : {}
  : {};
type GetReverseRefs<R, P extends PropertyKey> = P extends keyof R
  ? R[P] extends { references: infer RR extends object }
    ? RR
    : {}
  : {};

type ReverseRes<
  CM extends ConnMap,
  T extends Record<string, AnyCollection>,
  K extends string,
  R,
  FM extends FiltMap,
  D extends number = 0,
> = D extends 4
  ? {}
  : {
      [P in keyof R as P & string]: ReverseSources<CM, K, P & string> extends infer Src
        ? Src extends string
          ? Src extends keyof T
            ? (InferRes<CollSchema<T[Src]>, GetReverseWith<R, P>> &
                EntrySystemFields &
                ReverseRes<CM, T, Src, GetReverseRefs<R, P>, FM, Inc<D>>)[]
            : unknown[]
          : unknown[]
        : unknown[];
    };

// ── OrmConfig ────────────────────────────────────────────────────────────

export type OrmConfig<
  T extends Record<string, AnyCollection> = {},
  Opts extends { [K in keyof T]: object } = {
    [K in keyof T]: OptionsForColl<T[K]>;
  },
  CM extends ConnMap = {
    [K in keyof T]: Extract<Opts[K], { type: "connection"; path: string; value: string }>;
  },
  FM extends FiltMap = {
    [K in keyof T]: Extract<Opts[K], { type: "filter"; path: string; value: unknown }>;
  },
> = {
  [K in keyof T]: {
    findFirst: <
      W extends ConnArgs<CM, FM, K & string>,
      R extends ReverseConns<CM, FM, K & string>,
    >(args?: {
      where?: Filters<FM, K & string, CM>;
      with?: W;
      references?: R;
      ref?: string;
    }) => Promise<{
      org: string;
      repo: string;
      ref: string;
      version: string;
      name: string;
      commit: string;
      collection: T[K]["name"];
      value: (InferRes<CollSchema<T[K]>, W> & EntrySystemFields) &
        ReverseRes<CM, T, K & string, R, FM>;
    }>;

    findMany: <
      W extends ConnArgs<CM, FM, K & string>,
      R extends ReverseConns<CM, FM, K & string>,
    >(args?: {
      where?: Filters<FM, K & string, CM>;
      with?: W;
      references?: R;
      limit?: number;
      offset?: number;
      orderBy?: Record<string, "asc" | "desc">;
      variant?: string;
      ref?: string;
    }) => Promise<{
      collection: T[K]["name"];
      commitOid: string;
      items: ((InferRes<CollSchema<T[K]>, W> & EntrySystemFields) &
        ReverseRes<CM, T, K & string, R, FM>)[];
    }>;
  };
};

export type FindManyResult<T extends AnyCollection, TT extends object> = {
  collection: T["name"];
  commitOid: string;
  items: (InferRes<CollSchema<T>, TT> & EntrySystemFields)[];
};

import { z } from "zod/v4";
import type { Collection } from "@/client/config";

// // Collection type representing a collection with a schema
// type Collection = {
// 	schema: z.ZodObject<z.core.$ZodLooseShape, z.core.$strip>;
// };

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
    // SQLITE does not support arrayContains, arrayContained, or arrayOverlaps
    // arrayContains?: (T extends Array<infer E> ? (E | Placeholder)[] : T) | Placeholder | undefined;
    // arrayContained?: (T extends Array<infer E> ? (E | Placeholder)[] : T) | Placeholder | undefined;
    // arrayOverlaps?: (T extends Array<infer E> ? (E | Placeholder)[] : T) | Placeholder | undefined;
    like: z.string().optional(),
    ilike: z.string().optional(),
    notLike: z.string().optional(),
    notIlike: z.string().optional(),
    isNull: z.boolean().optional(),
    isNotNull: z.boolean().optional(),
    // This one is a bit finicky https://zod.dev/api?id=circularity-errors
    get OR(): z.ZodLazy<z.ZodOptional<z.ZodArray<typeof QuerySchema>>> {
      return z.lazy(() => z.array(QuerySchema).optional());
    },
  })
  .refine(
    (obj) => {
      return Object.values(obj).some((val) => val !== undefined);
    },
    {
      message: "At least one query condition must be specified.",
      path: [],
    },
  );

export type OrmConfig<
  // biome-ignore lint/complexity/noBannedTypes: This rule is dumb
  T extends Record<string, Collection> = {}, // Don't change this to Record
  Options extends { [K in keyof T]: object } = {
    [K in keyof T]: OptionsForCollection<T[K]>;
  },
  ConnectionOptions extends {
    [K in keyof T]: { type: "connection"; path: string; value: keyof T };
  } = {
    [K in keyof T]: Extract<
      Options[K],
      { type: "connection"; path: string; value: keyof T }
    >;
  },
  FilterOptions extends {
    [K in keyof T]: { type: "filter"; path: string; value: unknown };
  } = {
    [K in keyof T]: Extract<
      Options[K],
      { type: "filter"; path: string; value: unknown }
    >;
  },
  ConnectionArgs extends {
    [K in keyof T]: object;
  } = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [K in keyof T]: any;
  },
  FilterArgs extends {
    [K in keyof T]: object;
  } = {
    [K in keyof T]: Filters<SystemAndFilterArgs<FilterOptions, K, ConnectionOptions>>;
  },
> = {
  [K in keyof T]: {
    /**
     * Find the first item in the collection.
     *
     * TIP: for cache tags, you should use a composite of the `ref` and the returned `_meta.path`
     */
    findFirst: <TT extends ConnectionArgs[K]>(args?: {
      where?: FilterArgs[K];
      // per instruction: ignore with type errors → any for now
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      with?: any;
      ref?: string;
    }) => Promise<{
      org: string;
      repo: string;
      ref: string;
      version: string;
      name: string;
      commit: string;
      collection: T[K]["name"];
      value: InferResultType<T[K]["schema"], TT> & {
        slug: string;
        path: string;
      };
    }>;
    /**
     * Find the first item in the collection.
     *
     * TIP: for cache tags, you should use the `ref`
     */
    findMany: <TT extends ConnectionArgs[K]>(args?: {
      where?: FilterArgs[K];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      with?: any;
      ref?: string;
      variant?: string;
    }) => Promise<{
      collection: T[K]["name"];
      commitOid: string;
      items: (InferResultType<T[K]["schema"], TT> & {
        slug: string;
        path: string;
      })[];
    }>;
  };
};

export type FindManyResult<T extends Collection, TT extends object> = {
  collection: T["name"];
  commitOid: string;
  items: InferResultType<T["schema"], TT>[];
};

// Helper to infer the output type from ResultType
type InferResultType<T extends z.core.$ZodType, W extends object> = ResultType<
  T,
  W
> extends z.core.$ZodType<infer O>
  ? O
  : never;

type ResultType<
  T extends z.core.$ZodType,
  W extends object,
  CurrentPath extends string = "",
> = T extends z.ZodObject<infer Shape, infer Config>
  ? z.ZodObject<
      {
        [K in keyof Shape]: ResultType<
          Shape[K],
          W,
          `${MaybePrefix<CurrentPath>}${K & string}`
        >;
      },
      Config
    >
  : T extends z.ZodCodec<
        infer In extends z.ZodType,
        infer U extends z.core.$ZodType
      >
    ? z.ZodCodec<In, ResultType<U, W, CurrentPath>>
    : T extends z.ZodArray<infer U extends z.core.$ZodType>
      ? z.ZodArray<ResultType<U, W, CurrentPath>>
      : T extends z.ZodLazy<infer U extends z.core.$ZodType>
        ? z.ZodLazy<ResultType<U, W, CurrentPath>>
        : T extends z.ZodUnion<infer Options>
          ? z.ZodUnion<{
              [K in keyof Options]: ResultType<
                Options[K] extends z.core.$ZodType ? Options[K] : never,
                W,
                WithDiscriminant<
                  CurrentPath,
                  Options[K] extends z.core.$ZodType ? Options[K] : never
                >
              >;
            }>
          : T extends z.ZodOptional<infer U extends z.core.$ZodType>
            ? z.ZodOptional<ResultType<U, W, CurrentPath>>
            : T extends z.ZodCustom<infer Output, infer Input>
              ? CurrentPath extends keyof W
                ? W[CurrentPath] extends false
                  ? T
                  : Input extends z.ZodType
                    ? ResultType<
                        Input,
                        W[CurrentPath] extends { with: object }
                          ? W[CurrentPath]["with"]
                          : object
                      >
                    : never
                : Output extends z.ZodType
                  ? Output
                  : T
              : T;

// type OptionsForCollection<T extends Collection> = Paths<T["schema"]>;
type OptionsForCollection<T extends Collection> = Paths<
  T["schema"]["def"]["out"]
>;

type Paths<T extends z.ZodObject> = Prettify<
  {
    [Key in keyof T["shape"]]: FindTypes<T>;
  }[keyof T["shape"]]
>;

type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

type MaybePrefix<P extends string> = P extends "" ? "" : `${P}.`;

export type FindTypes<
  T extends z.core.$ZodType,
  CurrentPath extends string = "",
> = T extends z.ZodObject<infer Shape>
  ? {
      [K in keyof Shape]: FindTypes<
        Shape[K],
        `${MaybePrefix<CurrentPath>}${K & string}`
      >;
    }[keyof Shape]
  : T extends z.ZodArray<infer U extends z.core.$ZodType>
    ? FindTypes<U, CurrentPath>
    : T extends z.ZodLazy<infer U extends z.core.$ZodType>
      ? FindTypes<U, CurrentPath>
      : T extends z.ZodUnion<infer Options>
        ? {
            [K in keyof Options]: FindTypes<
              Options[K] extends z.core.$ZodType ? Options[K] : never,
              WithDiscriminant<
                CurrentPath,
                Options[K] extends z.core.$ZodType ? Options[K] : never
              >
            >;
          }[number]
        : T extends z.ZodOptional<infer U extends z.core.$ZodType>
          ? FindTypes<U, CurrentPath>
          : T extends z.ZodCustom<infer Output, infer Input>
            ? Input extends { __internalFilter: infer FilterType }
              ? { type: "filter"; value: FilterType; path: CurrentPath }
              : Output extends {
                    _collection: infer CollectionName;
                  }
                ? {
                    type: "connection";
                    value: CollectionName;
                    path: CurrentPath;
                  }
                : never
            : never;

type WithDiscriminant<
  P extends string,
  T extends z.core.$ZodType,
> = T extends z.ZodObject<infer Shape>
  ? {
      // FIXME this just grabs the first literal it finds, which is not always correct
      [K in keyof Shape]: Shape[K] extends z.ZodLiteral<infer Literal>
        ? `${MaybePrefix<P>}${Literal & string}`
        : never;
    }[keyof Shape]
  : T extends z.ZodCustom<infer Output>
    ? // When a connect is part of a union, treat is a discriminant
      Output extends { _collection: infer CollectionName }
      ? `${MaybePrefix<P>}${CollectionName & string}`
      : never
    : P;

type Connections<
  ConnectionOptions extends Record<
    string,
    {
      type: "connection";
      path: string;
      value: keyof ConnectionOptions;
    }
  >,
  K extends keyof ConnectionOptions,
> = {
  [C in ConnectionOptions[K] as C["path"]]?: C["value"] extends keyof ConnectionOptions
    ? // I _think_ this will make it lazy-ish so we dont get recursive loops. Not sure
      boolean | { readonly with?: Connections<ConnectionOptions, C["value"]> }
    : never;
};

type StringOrFilter = string | StringFiltersObj;

type SystemFilters = {
  path?: StringOrFilter;
  slug?: StringOrFilter;
  ref?: StringOrFilter;
  // also allow array form of eq/in etc still typed as object via StringFiltersObj
};

type SystemAndFilterArgs<
  FilterOptions extends Record<string, { type: "filter"; path: string; value: unknown }>,
  K extends keyof FilterOptions,
  ConnectionOptions extends Record<string, { type: "connection"; path: string; value: keyof ConnectionOptions }>,
> = SystemFilters &
  {
    [C in FilterOptions[K] as C["path"]]?: C["value"] extends string ? StringFiltersObj : never;
  } & (K extends keyof ConnectionOptions
    ? {
        readonly [KK in ConnectionOptions[K] as KK["path"]]?: KK["value"] extends keyof ConnectionOptions
          ? KK["value"] extends keyof FilterOptions
            ? Filters<SystemAndFilterArgs<FilterOptions, KK["value"], ConnectionOptions>>
            : never
          : never;
      }
    : object);

/**
 * TODO: this currenlty doesn't support OR operations across different fields.
 * I don't think there's any actual limitation to this except that it feels kind
 * of hard to type properly. It should be supported since I think Drizzle supports it.
 */
type Filters<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  F extends Record<string, any>,
> = F;

type StringFiltersObj = StringQueryType;

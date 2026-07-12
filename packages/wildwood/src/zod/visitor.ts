import type { Position } from "unist";
import { z } from "zod/v4";
import { registry } from "@/zod/extensions";

type ZodVisitorArgs = {
  schema: z.core.$ZodType<unknown, unknown>;
  variant: string;
  value: unknown;
  field?: (string | number)[];
  key?: (string | number)[];
  skipMutations?: boolean;
  onFilter: (args: {
    value: string;
    field: (string | number)[];
    key: (string | number)[];
    schema: z.core.$ZodType<unknown, unknown>;
    collection?: string;
  }) => void;
  onConnection: (args: {
    value: string;
    field: (string | number)[];
    key: (string | number)[];
    position: Position | undefined;
    referencedAs?: string;
    schema: z.core.$ZodType<unknown, unknown>;
    collection: string;
  }) => unknown | undefined;
};

export const zodVisitor = (args: ZodVisitorArgs): unknown => {
  const {
    schema: _schema,
    value,
    variant,
    field = [],
    key = [],
    skipMutations = false,
    onFilter,
    onConnection,
  } = args;
  const schema =
    _schema instanceof z.core.$ZodCodec
      ? // @ts-expect-error - accessing internal _def property
        (_schema as { _def: { out: z.core.$ZodTypes } })._def.out
      : (_schema as unknown as z.core.$ZodTypes);
  // @ts-expect-error - def property access on ZodTypes
  const def = schema.def;
  switch (def.type) {
    case "object": {
      const objDef = def as z.core.$ZodObjectDef;
      const obj = value as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        const s = objDef.shape[k];
        if (s) {
          const result = zodVisitor({
            schema: s,
            value: v,
            variant,
            field: [...field, k],
            key: [...key, k],
            skipMutations,
            onFilter,
            onConnection,
          });
          // If onConnection returned a value, mutate the object
          if (result !== undefined && !skipMutations) {
            obj[k] = result;
          }
        }
      }
      return value;
    }
    case "record": {
      const narrowedSchema = schema as z.ZodRecord;
      const obj = value as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        const result = zodVisitor({
          schema: narrowedSchema.def.valueType,
          value: v,
          variant,
          field: [...field, k],
          key: [...key, k],
          skipMutations,
          onFilter,
          onConnection,
        });
        // If onConnection returned a value, mutate the record
        if (result !== undefined && !skipMutations) {
          obj[k] = result;
        }
      }
      return value;
    }
    case "array": {
      const arr = value as unknown[];
      arr.forEach((v, index) => {
        const result = zodVisitor({
          schema: def.element,
          value: v,
          variant,
          field: [...field, index],
          key: [...key, index],
          skipMutations,
          onFilter,
          onConnection,
        });
        // If onConnection returned a value, mutate the array
        if (result !== undefined && !skipMutations) {
          arr[index] = result;
        }
      });
      return value;
    }
    case "custom": {
      if (def.params?.__tr33Filter) {
        if (typeof value === "string") {
          onFilter({ value, field, key, schema });
        }
      }
      if (def.params?.__tr33Connection) {
        const result = onConnection({
          value: value as string,
          field,
          key,
          schema,
          position: undefined,
          referencedAs: def.params?.referencedAs,
          collection: z
            .object({ __tr33Connection: z.string() })
            .decode(def.params).__tr33Connection,
        });
        // Return the result if provided, otherwise return original value
        return result !== undefined ? result : value;
      }
      return undefined;
    }
    case "union": {
      let realValue = value;
      const narrowedSchema = schema as z.ZodUnion;
      const isLocalized = registry.has(narrowedSchema);
      if (isLocalized) {
        const options: string[] = [];
        let depth = 0;
        variant.split("|").forEach((item) => {
          depth++;
          options.push(item.split(":")[1]);
        });
        let r = realValue;
        while (depth > 0 && typeof r === "object" && r !== null) {
          for (const option of options) {
            if (r && typeof r === "object" && option in r) {
              r = r[option as keyof typeof r];
              break;
            }
          }
          depth--;
        }
        if (skipMutations) {
          realValue = r;
        } else {
          return r;
        }
      }
      const option = narrowedSchema.def.options.find((option) => {
        // @ts-expect-error we know this type implements safeParse
        const parsedOption = option.safeParse(realValue);
        return parsedOption.success;
      });
      if (option?._zod.def.type === "object") {
        const optionDef = option._zod.def as z.core.$ZodObjectDef;
        const shape = z.record(z.string(), z.instanceof(z.ZodType));
        // Use type assertion to handle readonly shape
        const decodedShape = shape.decode(
          optionDef.shape as Record<
            string,
            z.ZodType<
              unknown,
              unknown,
              z.core.$ZodTypeInternals<unknown, unknown>
            >
          >,
        );
        for (const val of Object.values(decodedShape)) {
          if (val._zod.def.type === "literal") {
            const literal = val._zod.def as z.core.$ZodLiteralDef<string>;
            field.push(literal.values[0] as string);
          }
        }
      }
      // If the union options are connections, append their collection
      // names to the path as a discriminant
      if (option?._zod.def.type === "custom") {
        // @ts-expect-error - we know this is a collection
        field.push(option._zod.def?.params?.__tr33Connection);
      }
      if (option) {
        return zodVisitor({
          schema: option,
          value: realValue,
          variant,
          field,
          key,
          skipMutations,
          onFilter,
          onConnection,
        });
      }
      return undefined;
    }
    case "pipe": {
      // console.log('pipe', schema)
      const narrowedSchema = schema as z.ZodPipe;
      const inResult = zodVisitor({
        schema: narrowedSchema.def.in,
        value,
        variant,
        field,
        key,
        skipMutations,
        onFilter,
        onConnection,
      });
      // If the 'in' schema returned a value (e.g., localized), use it
      if (inResult !== undefined) {
        return inResult;
      }
      return zodVisitor({
        schema: narrowedSchema.def.out,
        value,
        variant,
        field,
        key,
        skipMutations,
        onFilter,
        onConnection,
      });
    }
    case "optional": {
      const narrowedSchema = schema as z.ZodOptional;
      return zodVisitor({
        schema: narrowedSchema.def.innerType,
        value,
        variant,
        field,
        key,
        onFilter,
        onConnection,
      });
    }
    case "lazy": {
      const narrowedSchema = schema as z.ZodLazy;
      return zodVisitor({
        schema: narrowedSchema.def.getter(),
        value,
        variant,
        field,
        key,
        skipMutations,
        onFilter,
        onConnection,
      });
    }
    case "nullable": {
      const narrowedSchema = schema as z.ZodNullable;
      return zodVisitor({
        schema: narrowedSchema.def.innerType,
        value,
        variant,
        field,
        key,
        skipMutations,
        onFilter,
        onConnection,
      });
    }
    // Not sure how to handle this one
    case "transform": {
      return undefined;
    }
    case "number": {
      return undefined;
    }
    case "boolean": {
      return undefined;
    }
    case "literal": {
      return undefined;
    }
    case "string": {
      return undefined;
    }
    case "any": {
      return undefined;
    }
    default: {
      throw new Error(
        `Unsupported schema type: ${def.type} at ${field.join(".")}`,
      );
    }
  }
};

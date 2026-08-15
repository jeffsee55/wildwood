import { customType } from "drizzle-orm/sqlite-core";

/** Better Auth stores ISO date values in SQLite columns declared as `date`. */
export const sqliteDate = customType<{ data: Date; driverData: string }>({
  dataType() {
    return "date";
  },
  toDriver(value) {
    return value.toISOString();
  },
  fromDriver(value) {
    return new Date(value);
  },
});

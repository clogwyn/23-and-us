declare const brand: unique symbol;

/** Nominal typing: a `Brand<string, "TaskId">` is not assignable from a plain string. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

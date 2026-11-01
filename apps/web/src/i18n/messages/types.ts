/** Same shape as a catalogue, with every text widened to plain `string`. */
export type Widen<T> = T extends string ? string : { readonly [K in keyof T]: Widen<T[K]> };

import { useEffect, useState } from "react";

const serializeSetting = (value: unknown): string =>
  typeof value === "boolean" ? (value ? "1" : "0") : String(value);

/** Keep the existing storage format; parsing owns defaults and validation. */
export function usePersistedSetting<T>(
  key: string,
  parse: (stored: string | null) => T,
  serialize: (value: T) => string = serializeSetting,
) {
  const [value, setValue] = useState(() => parse(localStorage.getItem(key)));
  useEffect(() => {
    localStorage.setItem(key, serialize(value));
  }, [key, value, serialize]);
  return [value, setValue] as const;
}

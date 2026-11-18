import { z } from "zod";

// E25: a display name must contain something visible. Format characters (zero-width space,
// joiners, BOM: \p{Cf}) are removed and unusual spaces (\p{Zs}) become normal spaces before
// the "not blank" check, so a name made only of zero-width spaces is rejected.
const displayName = (max = 100) =>
  z
    .string()
    .transform((value) =>
      value
        .replace(/\p{Cf}/gu, "")
        .replace(/\p{Zs}/gu, " ")
        .trim()
    )
    .pipe(z.string().min(1, "Must not be blank").max(max));

export { displayName };

"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/** GET `path` (null = skip). Re-fetches when `path` changes or `reload()` is called. */
export function useApi<T>(path: string | null) {
  const [state, setState] = useState<{
    data?: T;
    error?: unknown;
    loading: boolean;
  }>({ loading: true });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>(path).then(
      (data) => live && setState({ data, loading: false }),
      (error) => live && setState({ error, loading: false })
    );
    return () => {
      live = false;
    };
  }, [path, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
}

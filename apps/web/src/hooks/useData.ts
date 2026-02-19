import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getDataRows } from "../api/client";
import { transformRows } from "../utils/transformClient";

export function useRowsQuery(dashboardId: string, token: string, requestId: string) {
  return useQuery({
    queryKey: ["rows", dashboardId, requestId],
    queryFn: () => getDataRows(dashboardId, token, requestId),
    enabled: Boolean(dashboardId && token && requestId),
    staleTime: 30_000,
  });
}

export function useTransformedRows(rows: any[] | undefined, transform: unknown | undefined) {
  const [out, setOut] = useState<any[] | undefined>(rows);
  const transformKey = useMemo(() => JSON.stringify(transform ?? null), [transform]);

  useEffect(() => {
    let canceled = false;
    if (!rows) {
      setOut(undefined);
      return;
    }
    if (!transform) {
      setOut(rows);
      return;
    }
    transformRows(rows, JSON.parse(transformKey))
      .then((r) => {
        if (!canceled) setOut(r);
      })
      .catch(() => {
        if (!canceled) setOut(rows);
      });
    return () => {
      canceled = true;
    };
  }, [rows, transformKey, transform]);

  return out;
}


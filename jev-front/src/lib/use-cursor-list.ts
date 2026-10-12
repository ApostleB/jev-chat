import { useInfiniteQuery } from "@tanstack/react-query";
import { PageSchema } from "@jev-chat/protocol";
import type { z } from "zod";
import { api } from "./api";

/** `{ items, nextCursor }` 목록을 서버 순서 그대로 이어 붙인다(클라이언트 재정렬 없음). queryKey 두 번째 원소는 authEpoch. */
export function useCursorList<T>(opts: { key: string; authEpoch: number; path: string; params?: Record<string, string>; item: z.ZodType<T>; enabled: boolean }) {
  const { key, authEpoch, path, params = {}, item, enabled } = opts;
  const q = useInfiniteQuery({
    queryKey: [key, authEpoch, path, params],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const qs = new URLSearchParams(params);
      if (pageParam) qs.set("cursor", pageParam);
      const s = qs.toString();
      return api.get(s ? `${path}?${s}` : path, PageSchema(item), { signal });
    },
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
  return { ...q, items: q.data?.pages.flatMap((p) => p.items) ?? [] };
}

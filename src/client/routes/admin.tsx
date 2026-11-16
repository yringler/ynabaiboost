// routes/admin.tsx — WP6 (DESIGN §11.2 "/admin"): users table with the STT switch. Access itself is the D16 vars.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { z } from "zod";
import type { AdminUsersRes } from "../../shared/api";
import { PageTitle } from "../components/Page";
import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { call, errorMessage } from "../lib/api";
import { formatRelative, formatTimestamp } from "../lib/format";
import { queryKeys } from "../lib/queryKeys";

type UsersRes = z.infer<typeof AdminUsersRes>;

export function AdminPage() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: queryKeys.adminUsers, queryFn: ({ signal }) => call("adminUsers", { signal }) });
  const patch = useMutation({
    mutationFn: ({ id, sttAllowed }: { id: string; sttAllowed: boolean }) =>
      call("adminPatchUser", { params: { id }, body: { sttAllowed } }),
    onMutate: async ({ id, sttAllowed }) => {
      await qc.cancelQueries({ queryKey: queryKeys.adminUsers });
      const prev = qc.getQueryData<UsersRes>(queryKeys.adminUsers);
      qc.setQueryData<UsersRes>(queryKeys.adminUsers, (d) =>
        d ? { users: d.users.map((u) => (u.userId === id ? { ...u, sttAllowed } : u)) } : d);
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKeys.adminUsers, ctx.prev);
      toast.error(errorMessage(e));
    },
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.adminUsers });
      await qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <PageTitle>Admin</PageTitle>
      <p className="text-sm text-muted-foreground">
        Who may sign in is set by the <code>ADMIN_USER_IDS</code> and <code>ALLOWED_USER_IDS</code> vars. Here you can allow server voice
        transcription (Workers AI) per user.
      </p>
      {users.isPending && <Skeleton className="h-32 w-full" />}
      {users.isError && <p className="text-sm text-destructive">{errorMessage(users.error)}</p>}
      {users.data && (
        <ul className="divide-y rounded-xl border bg-card">
          {users.data.users.map((u) => (
            <li key={u.userId} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <code className="truncate text-sm">{u.userId}</code>
                  {u.isAdmin && <Badge variant="secondary">admin</Badge>}
                  <Badge variant="outline" className="uppercase">{u.authType}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Joined {formatTimestamp(u.createdAt)} · seen <span title={formatTimestamp(u.lastSeenAt)}>{formatRelative(u.lastSeenAt)}</span>
                </p>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Server STT
                <Switch
                  checked={u.sttAllowed}
                  onCheckedChange={(sttAllowed) => patch.mutate({ id: u.userId, sttAllowed })}
                  aria-label={`Server STT for ${u.userId}`}
                />
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

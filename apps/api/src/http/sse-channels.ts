import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { agents, type Database } from '@apos/db';
import type { RequestActor } from './rbac';

/**
 * Per-channel authorization for the SSE stream (docs/tech/07-api-design.md §5, item 1) /
 * SSE 频道的逐条鉴权（docs/tech/07-api-design.md §5 的第 1 条）。
 *
 * ★★ This stream used to verify the token and never the channels: any logged-in account could
 *   pass `?channels=project:<someone else's project>:board` and receive every domain event
 *   that project pushes — status transitions, decisions, policy verdicts, run output. The same
 *   person hitting REST's `/projects/:id/board` gets a 404, while the realtime side stood wide
 *   open. A multi-tenant boundary cannot exist on the REST half alone.
 *
 * ★ Drop channels rather than refusing the whole request: one connection carries a dozen
 *   channels (the board, several cards, several runs), and one of them being out of bounds
 *   must not disconnect the other nine. The out-of-bounds ones are discarded, and the set that
 *   **actually took effect** is echoed to the client in the `ready` event — so the frontend
 *   knows which subscriptions did not land instead of waiting forever on a channel that will
 *   never push.
 *
 * ★ When nothing survives, return null and let the caller refuse the connection outright.
 *   Opening an empty stream is worse than an error: the UI looks connected and simply never
 *   moves.
 *   这条流此前只验令牌不验频道：任何登录账号带上
 *   `?channels=project:<别人的项目>:board` 就能拿到那个项目推送的全部
 *   领域事件 —— 状态流转、决策、Policy 判定、Run 产出。同一个人去打
 *   REST 的 `/projects/:id/board` 会拿到 404，实时流这一侧却是敞开的。
 *   多租户边界不能只建立在 REST 那一半上。
 *   剔除而不是整体拒绝：一次连接会带上十来个频道（看板 + 若干卡片 +
 *   若干 Run），其中一个越界不该让另外九个也断掉。越界的那些原样丢弃，
 *   并把**实际生效的频道**在 `ready` 事件里回给客户端 —— 前端据此知道
 *   哪些没订上，而不是对着一条永远不推数据的频道干等。
 *   一条都不剩时回 null，由调用方拒掉整条连接。开一条空流比报错更糟：
 *   界面看起来连上了，只是永远不动。
 */

export interface ChannelAuthDeps {
  db: Database;
  /** The non-throwing membership check / 不抛版本的成员关系判定 */
  projectAccess: (
    req: FastifyRequest,
    projectId: string,
    userId: string,
  ) => Promise<RequestActor | null>;
  /** Resource id → owning project; the same resolver the gate uses / 资源 id → 所属项目，与闸门共用同一张表 */
  projectOfResource: (kind: string, id: string) => Promise<string | null>;
}

export interface ChannelAuthResult {
  allowed: string[];
  denied: string[];
}

/**
 * Channel name → who governs it / 频道名 → 它归谁管。
 *
 * ★ An unrecognized channel is always refused. Defaulting to allow means that forgetting to
 *   register a newly added channel kind opens an undefended hole, and nothing in the UI would
 *   show it — the same discipline as ROUTE_PERMISSIONS in rbac.ts: closed by default.
 *   认不出来的频道一律拒。默认放行的话，新增一种频道时忘了登记
 *   就等于开了一个不设防的口子，而这件事从界面上完全看不出来 ——
 *   与 rbac.ts 的 ROUTE_PERMISSIONS 是同一条纪律：默认关着。
 */
type ChannelScope =
  | { kind: 'project'; projectId: string }
  | { kind: 'resource'; resource: string; id: string }
  | { kind: 'agent'; agentId: string }
  | { kind: 'self'; userId: string }
  | { kind: 'unknown' };

export function scopeOf(channel: string): ChannelScope {
  const parts = channel.split(':');
  const [kind, id, suffix] = parts;
  if (!id) return { kind: 'unknown' };

  if (kind === 'project' && suffix === 'board' && parts.length === 3) {
    return { kind: 'project', projectId: id };
  }
  if (kind === 'work_item' && parts.length === 2) {
    return { kind: 'resource', resource: 'work-items', id };
  }
  if (kind === 'run' && parts.length === 2) return { kind: 'resource', resource: 'runs', id };
  if (kind === 'decision' && parts.length === 2) {
    return { kind: 'resource', resource: 'decisions', id };
  }
  if (kind === 'agent' && parts.length === 2) return { kind: 'agent', agentId: id };
  if (kind === 'user' && suffix === 'decisions' && parts.length === 3) {
    return { kind: 'self', userId: id };
  }
  return { kind: 'unknown' };
}

export async function authorizeChannels(
  deps: ChannelAuthDeps,
  req: FastifyRequest,
  actor: RequestActor,
  channels: string[],
): Promise<ChannelAuthResult> {
  const allowed: string[] = [];
  const denied: string[] = [];

  /** Several channels in one connection hit the same project, so remember what was decided */
  const decided = new Map<string, boolean>();
  const mayReadProject = async (projectId: string): Promise<boolean> => {
    const cached = decided.get(projectId);
    if (cached !== undefined) return cached;
    const ok = (await deps.projectAccess(req, projectId, actor.userId)) !== null;
    decided.set(projectId, ok);
    return ok;
  };

  for (const channel of channels) {
    const scope = scopeOf(channel);
    let ok = false;

    switch (scope.kind) {
      case 'project':
        ok = await mayReadProject(scope.projectId);
        break;
      case 'resource': {
        const projectId = await deps.projectOfResource(scope.resource, scope.id);
        /**
         * ★ No resolvable owning project means refuse. "The resource does not exist" and "it
         *   exists but is not yours" take the same path here — letting a nonexistent id through
         *   would turn this stream into a probe for "does this id exist".
         *   查不到所属项目就拒。资源不存在与「存在但不属于你」在这里
         *   走同一条路 —— 放行不存在的资源 id 会让这条流变成一个
         *   「这个 id 存不存在」的探针。
         */
        ok = projectId !== null && (await mayReadProject(projectId));
        break;
      }
      case 'agent': {
        /**
         * ★ Agents are org-level resources with no project in the URL, so the check stops at
         *   the organization. Everyone in the same organization can watch an agent's activity
         *   (the agent detail page is org-level to begin with); across organizations, never.
         *   Agent 是组织级资源，URL 上没有项目 —— 判到组织为止。
         *   同组织的成员都看得到 Agent 的动态（Agent 详情页本来就是
         *   组织级的），跨组织一律不行。
         */
        const [row] = await deps.db
          .select({ orgId: agents.orgId })
          .from(agents)
          .where(eq(agents.id, scope.agentId));
        ok = row?.orgId === actor.orgId;
        break;
      }
      case 'self':
        // "Decisions assigned to me" can only ever mean your own
        ok = scope.userId === actor.userId;
        break;
      case 'unknown':
        ok = false;
        break;
    }

    if (ok) allowed.push(channel);
    else denied.push(channel);
  }

  return { allowed, denied };
}

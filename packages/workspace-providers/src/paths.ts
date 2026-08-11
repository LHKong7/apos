import { join, resolve } from 'node:path';

/**
 * 工作区根目录下的布局。
 *
 *   {root}/mirrors/{repoId}.git   裸镜像，仓库级共享的对象库
 *   {root}/runs/{runId}/{name}/   每次执行一棵独立工作树
 *   {root}/state/{workspaceId}.json  无版本控制后端的基线快照
 *
 * ★ 镜像按 **repoId** 而不是 repoRef 命名：ref 是管理员可改的展示名，
 *   跟着它走的话改一次名就等于丢掉整个本地对象库，下一次派发要重新
 *   全量 clone。
 */
export function workspaceRoot(explicit?: string): string {
  return resolve(explicit ?? process.env['AGENT_WORKSPACE_ROOT'] ?? '/tmp/apos-workspaces');
}

export function mirrorDir(root: string, repoId: string): string {
  return join(root, 'mirrors', `${repoId}.git`);
}

export function runDir(root: string, runId: string): string {
  return join(root, 'runs', runId);
}

/**
 * 基线快照的存放处。
 *
 * ★ 刻意放在**工作目录之外**：放里面的话 Agent 看得见它、可能顺手删掉或改掉，
 *   而且快照文件本身会出现在自己的 diff 里 —— 一个把自己算成产物的基线。
 */
export function stateFile(root: string, workspaceId: string): string {
  return join(root, 'state', `${workspaceId}.json`);
}

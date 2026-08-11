import type { ChangeSet, PublishResult, Workspace } from '@apos/contracts';

export interface ReleaseContext {
  runId: string;
  outcome: 'completed' | 'failed' | 'terminated' | 'timeout';
  summary: string;
  agentName: string;
  /** 任务目标，进提交信息标题 */
  goal: string;
}

/**
 * 交货后端 —— 「目录里的变化送到哪去」。
 *
 * ★★ 与铺料后端**独立可选**。从 Git 拉代码、把生成的报告传对象存储是
 *   最常见的组合，而把两者捆进一个 Provider 接口就表达不了这件事。
 *   这也是本抽象与「一个 WorkspaceProvider 管到底」那种设计的关键分歧。
 */
export interface Publisher {
  readonly kind: PublishResult['kind'];

  publish(ws: Workspace, changes: ChangeSet, ctx: ReleaseContext): Promise<PublishResult>;

  /**
   * 交货并且**工作树已回收**之后的收尾。可选。
   *
   * ★ 单独一个钩子而不是塞进 publish，是因为 Git 那边要删的东西
   *   （已推送的本地分支）在工作树还在时删不掉 —— git 拒绝删除正被
   *   检出的分支。顺序上它必须跨在 dispose 之后。
   */
  finalize?(ws: Workspace, result: PublishResult): Promise<void>;
}

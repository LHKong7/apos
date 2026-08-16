import { describe, expect, it } from 'vitest';
import type { ResourceScope } from '@apos/contracts';
import { effectiveResourceScopes } from './resource-scopes';

const repo = (ref: string, access: ResourceScope['access']): ResourceScope => ({
  kind: 'repo',
  ref,
  access,
});

describe('effectiveResourceScopes', () => {
  it('项目级仓库没配过就默认只读', () => {
    const scopes = effectiveResourceScopes({ explicit: [], projectRepoRefs: ['main-repo'] });

    expect(scopes).toEqual([
      { kind: 'repo', ref: 'main-repo', access: 'read', origin: 'project_default' },
    ]);
  });

  it('默认档只到 read —— write 不会被默认出来', () => {
    const scopes = effectiveResourceScopes({ explicit: [], projectRepoRefs: ['main-repo'] });

    expect(scopes.every((s) => s.access !== 'write')).toBe(true);
  });

  it('显式配的 write 不会被默认覆盖', () => {
    const scopes = effectiveResourceScopes({
      explicit: [repo('main-repo', 'write')],
      projectRepoRefs: ['main-repo'],
    });

    expect(scopes).toEqual([
      { kind: 'repo', ref: 'main-repo', access: 'write', origin: 'explicit' },
    ]);
  });

  /**
   * ★ 这条是撤销权限的唯一写法，红了说明「收回某个 Agent 的仓库权限」
   *   在产品上无法表达（删掉那条会回落到默认只读）。
   */
  it('显式写成 none 能压过默认 —— 否则权限撤不回来', () => {
    const scopes = effectiveResourceScopes({
      explicit: [repo('main-repo', 'none')],
      projectRepoRefs: ['main-repo'],
    });

    expect(scopes).toEqual([{ kind: 'repo', ref: 'main-repo', access: 'none', origin: 'explicit' }]);
    expect(scopes.some((s) => s.origin === 'project_default')).toBe(false);
  });

  it('org 级仓库不参与默认 —— 调用方不把它放进 projectRepoRefs', () => {
    const scopes = effectiveResourceScopes({ explicit: [], projectRepoRefs: [] });

    expect(scopes).toEqual([]);
  });

  it('dataset 与其它 kind 不受影响，且都标成 explicit', () => {
    const dataset: ResourceScope = { kind: 'dataset', ref: 'bucket-a', access: 'write' };
    const scopes = effectiveResourceScopes({
      explicit: [dataset],
      projectRepoRefs: ['main-repo'],
    });

    expect(scopes).toEqual([
      { kind: 'dataset', ref: 'bucket-a', access: 'write', origin: 'explicit' },
      { kind: 'repo', ref: 'main-repo', access: 'read', origin: 'project_default' },
    ]);
  });

  /**
   * ★ 同名 ref 的 dataset 不该挡住 repo 的默认 —— 两类的 ref 各有命名空间，
   *   混判的表现是「登记了一个同名的 bucket，仓库就读不到了」。
   */
  it('同名的 dataset 不影响 repo 的默认', () => {
    const scopes = effectiveResourceScopes({
      explicit: [{ kind: 'dataset', ref: 'main-repo', access: 'read' }],
      projectRepoRefs: ['main-repo'],
    });

    expect(scopes).toContainEqual({
      kind: 'repo',
      ref: 'main-repo',
      access: 'read',
      origin: 'project_default',
    });
  });

  it('去重且按 ref 排序 —— 快照顺序不稳会看起来像权限变了', () => {
    const a = effectiveResourceScopes({
      explicit: [],
      projectRepoRefs: ['zeta', 'alpha', 'zeta'],
    });
    const b = effectiveResourceScopes({
      explicit: [],
      projectRepoRefs: ['alpha', 'zeta'],
    });

    expect(a.map((s) => s.ref)).toEqual(['alpha', 'zeta']);
    expect(a).toEqual(b);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { workspaceRoot } from './paths';

/**
 * 工作区根的解析。
 *
 * ★ 这里只测一件事：**空值不能落成进程当前目录**。
 *
 *   `.env.example` 里 `AGENT_WORKSPACE_ROOT=` 是留空的，source 进环境就是
 *   空字符串。用 `??` 挡不住它，而 `resolve('')` 返回 cwd —— 于是裸镜像与
 *   工作树会长在代码仓库里，pruneOrphans 回收时删的也是那里。
 *   这个后果太贵，且从「根目录 」这行空日志上看不出来，所以焊死在测试里。
 */

const KEY = 'AGENT_WORKSPACE_ROOT';
const ORIGINAL = process.env[KEY];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[KEY];
  else process.env[KEY] = ORIGINAL;
});

describe('workspaceRoot', () => {
  it('没有任何配置时用平台默认值', () => {
    delete process.env[KEY];
    expect(workspaceRoot()).toBe('/tmp/apos-workspaces');
  });

  it('环境变量是空串时当作没设置，而不是落到 cwd', () => {
    process.env[KEY] = '';
    expect(workspaceRoot()).toBe('/tmp/apos-workspaces');
    expect(workspaceRoot()).not.toBe(process.cwd());
  });

  it('显式传空串同样当作没设置', () => {
    delete process.env[KEY];
    expect(workspaceRoot('')).toBe('/tmp/apos-workspaces');
    expect(workspaceRoot('   ')).toBe('/tmp/apos-workspaces');
  });

  it('显式参数优先于环境变量', () => {
    process.env[KEY] = '/from/env';
    expect(workspaceRoot('/from/arg')).toBe('/from/arg');
  });

  it('环境变量有值时用它，两侧空白不算内容', () => {
    process.env[KEY] = '  /srv/apos  ';
    expect(workspaceRoot()).toBe('/srv/apos');
  });
});

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRuns, artifacts, workItems } from '@apos/db';
import { eq } from 'drizzle-orm';
import { listArtifactFiles, readArtifactFile } from './artifact-files';
import { createWorkItem, resetDb, seedFixture, testDb, type Fixture } from '../test/db';

/**
 * 产物文件网关。
 *
 * ★★ 这组测试的重点是**越界防护**，不是能不能读到文件。
 *
 *   归档目录是宿主机上的真实路径，网关一旦能被 `..` 或符号链接带出去，
 *   它就成了一个「读任意文件」的接口 —— 而且是带着登录身份的。
 */

const db = testDb();
let fx: Fixture;
let root: string;

beforeEach(async () => {
  await resetDb(db);
  fx = await seedFixture(db);
  root = await mkdtemp(join(tmpdir(), 'apos-artifact-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await db.delete(agentRuns).where(eq(agentRuns.orgId, fx.orgId));
  await db.delete(workItems).where(eq(workItems.orgId, fx.orgId));
});

/** 造一条指向 root 的本地产物 */
async function seedArtifact(storageKey: string | null = root): Promise<string> {
  const item = await createWorkItem(db, fx);
  const [row] = await db
    .insert(artifacts)
    .values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      workItemId: item.id,
      kind: 'workspace_output',
      title: '工作区产出',
      storage: 'inline',
      storageKey,
      producedByType: 'agent',
    })
    .returning({ id: artifacts.id });
  return row!.id;
}

describe('产物文件列举', () => {
  it('列出归档里的文件与目录，路径是相对的', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'README.md'), '# hi', 'utf8');
    await writeFile(join(root, 'src', 'app.ts'), 'export const a = 1;', 'utf8');

    const listed = await listArtifactFiles(db, await seedArtifact());
    expect(listed.available).toBe(true);
    const paths = listed.files.map((f) => f.path);
    expect(paths).toContain('README.md');
    expect(paths).toContain(join('src', 'app.ts'));
    // ★ 绝不能把宿主机绝对路径漏给调用方
    expect(JSON.stringify(listed)).not.toContain(root);
  });

  /**
   * ★ 目录没了要如实说，不能回空列表。
   *   空列表读起来像「这次没产出」，而真相是产出被回收了 ——
   *   两者的下一步动作完全不同。
   */
  it('★ 归档目录不存在时说明原因，而不是回一个空列表', async () => {
    const id = await seedArtifact(join(root, 'gone'));
    const listed = await listArtifactFiles(db, id);
    expect(listed.available).toBe(false);
    expect(listed.reason).toContain('不存在');
  });

  it('★ 没有本地归档目录的产物（git / 对象存储）明确拒绝', async () => {
    const id = await seedArtifact(null);
    await expect(listArtifactFiles(db, id)).rejects.toThrow(/没有本地归档目录/);
  });
});

describe('产物文件读取', () => {
  it('文本文件给预览内容', async () => {
    await writeFile(join(root, 'notes.md'), '内容', 'utf8');
    const file = await readArtifactFile(db, await seedArtifact(), 'notes.md');
    expect(file.preview).toBe('内容');
    expect(file.mime).toContain('markdown');
  });

  it('★ 二进制文件不塞进 JSON，并说清楚为什么', async () => {
    await writeFile(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const file = await readArtifactFile(db, await seedArtifact(), 'logo.png');
    expect(file.preview).toBeNull();
    expect(file.reason).toContain('二进制');
  });

  it('没有扩展名的文件按文本处理（Makefile / Dockerfile）', async () => {
    await writeFile(join(root, 'Makefile'), 'all:\n\techo hi', 'utf8');
    const file = await readArtifactFile(db, await seedArtifact(), 'Makefile');
    expect(file.preview).toContain('echo hi');
  });

  /**
   * ★★ 这一条是整个网关存在的风险点。
   *
   *   挡不住 `..` 的话，`GET /artifacts/:id/files/../../etc/passwd`
   *   就能读到归档目录之外的任何文件 —— 而调用者是带着登录身份的。
   */
  it('★ 用 .. 越界一律拒绝', async () => {
    const id = await seedArtifact();
    for (const evil of ['../secret', '../../etc/passwd', 'src/../../outside', '..']) {
      await expect(readArtifactFile(db, id, evil), evil).rejects.toThrow(/越界/);
    }
  });

  it('★ 绝对路径一律拒绝', async () => {
    const id = await seedArtifact();
    await expect(readArtifactFile(db, id, '/etc/passwd')).rejects.toThrow(/越界|不存在/);
  });

  /**
   * ★ 符号链接单独挡一次：路径判定全过，而内容在归档目录之外。
   *   只判字符串的实现会放它过去。
   */
  it('★ 指向归档目录之外的符号链接要挡下来', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'apos-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'TOP SECRET', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));

    const id = await seedArtifact();
    await expect(readArtifactFile(db, id, 'link.txt')).rejects.toThrow(/越界/);

    await rm(outside, { recursive: true, force: true });
  });

  it('不存在的文件回 404 而不是空内容', async () => {
    await expect(readArtifactFile(db, await seedArtifact(), 'nope.txt')).rejects.toThrow(
      /不存在/,
    );
  });
});

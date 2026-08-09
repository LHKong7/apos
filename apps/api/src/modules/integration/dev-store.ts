import { and, eq } from 'drizzle-orm';
import { devExternalObjects, type Database } from '@apos/db';
import type { ExternalObject, ExternalStore } from '@apos/integrations';

/**
 * 进程内适配器的持久化后端（仅开发/演示用）。
 *
 * ★ 它存的是「假外部系统的内容」，不是集成配置 —— 表名带 dev_ 前缀
 *   就是为了不让人误以为它是生产数据。真实 provider 接上后可以直接删。
 *
 * ★ 之所以要持久化：种子脚本和 API 是两个进程。假外部系统只活在
 *   种子进程里的话，页面上点「立即同步」什么也不会发生，
 *   而「同步真的会跑」正是这一页最该被看见能工作的一步。
 */
export class DevExternalStore implements ExternalStore {
  constructor(private db: Database) {}

  async get(provider: string, key: string): Promise<ExternalObject | undefined> {
    const [row] = await this.db
      .select()
      .from(devExternalObjects)
      .where(
        and(eq(devExternalObjects.provider, provider), eq(devExternalObjects.externalKey, key)),
      );
    return row ? toObject(row) : undefined;
  }

  async list(provider: string, limit: number): Promise<ExternalObject[]> {
    const rows = await this.db
      .select()
      .from(devExternalObjects)
      .where(eq(devExternalObjects.provider, provider))
      .limit(limit);
    return rows.map(toObject);
  }

  async put(provider: string, obj: ExternalObject): Promise<void> {
    await this.db
      .insert(devExternalObjects)
      .values({
        provider,
        externalKey: obj.externalKey,
        url: obj.url,
        fields: obj.fields as Record<string, unknown>,
        lastChange: (obj.lastChange ?? null) as Record<string, unknown> | null,
        deleted: obj.deleted ?? false,
      })
      .onConflictDoUpdate({
        target: [devExternalObjects.provider, devExternalObjects.externalKey],
        set: {
          url: obj.url,
          fields: obj.fields as Record<string, unknown>,
          lastChange: (obj.lastChange ?? null) as Record<string, unknown> | null,
          deleted: obj.deleted ?? false,
          updatedAt: new Date(),
        },
      });
  }
}

function toObject(row: typeof devExternalObjects.$inferSelect): ExternalObject {
  return {
    externalKey: row.externalKey,
    url: row.url,
    fields: row.fields as ExternalObject['fields'],
    lastChange: row.lastChange as ExternalObject['lastChange'],
    deleted: row.deleted,
  };
}

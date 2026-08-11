import { ApiError } from '../../http/errors';

/**
 * 注册端点的粗粒度限流。
 *
 * ★★ 为什么注册这条路必须有闸，而登录不需要一样的闸。
 *
 *   注册是**未鉴权**的，而且每一次调用都要跑一遍 scrypt（口令散列按设计
 *   就是昂贵的，见 password.ts 的 N/r/p）并写四张表。没有任何限制的话，
 *   几十个并发就能把 CPU 打满 —— 这不是「有人恶意刷」才会发生，
 *   一个写错的脚本就够了。顺带它也压住了「拿注册接口枚举邮箱」：
 *   注册必须如实回答「这个邮箱被占用了」，那条信道堵不上，只能限速。
 *
 * ★★ 这是**进程内**的，不是分布式限流。
 *
 *   多副本部署时每个副本各算各的，真实上限是这里的 N 乘以副本数。
 *   它挡的是「一个客户端猛打」这一类，不是有组织的分布式滥用 ——
 *   那一层该在入口（nginx / 云 WAF）做。写在这里是因为「服务本身
 *   至少不能一戳就倒」，不是因为它够用。
 *
 * ★ 按 IP 而不是按邮箱：按邮箱的话，换一个邮箱就绕过去了，
 *   而滥用者本来每次就要换一个新邮箱。
 */

/** 窗口长度与窗口内允许的次数。定得比「一个人正常注册」宽出两个数量级 */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 10;

/** 超过这个规模就整体清一次 —— 防止有人拿伪造 IP 把这张表撑成内存泄漏 */
const MAX_KEYS = 10_000;

const hits = new Map<string, number[]>();

/**
 * 记一次调用，超限则抛。
 *
 * @param key 调用方标识，通常是 IP
 * @param now 便于测试注入；生产不传
 */
export function assertSignupAllowed(key: string, now: number = Date.now()): void {
  if (hits.size > MAX_KEYS) hits.clear();

  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= MAX_PER_WINDOW) {
    /**
     * ★ 说清楚「多久之后能再试」。只说「太频繁了」的话，用户唯一的
     *   办法就是不停重试 —— 那正好让限流器一直保持在触发状态。
     */
    const retryInMinutes = Math.ceil((WINDOW_MS - (now - recent[0]!)) / 60_000);
    throw new ApiError(
      'RATE_LIMITED',
      `注册太频繁了，请 ${retryInMinutes} 分钟后再试`,
      { retryInMinutes },
    );
  }

  recent.push(now);
  hits.set(key, recent);
}

/** 仅供测试：清空计数 */
export function resetSignupThrottle(): void {
  hits.clear();
}

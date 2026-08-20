import { fail } from '../../http/errors';

/**
 * 自助注册的总开关（`APOS_ALLOW_SIGNUP`）。
 *
 * ★★ 默认**开着**。不配这个变量的实例可以自助注册。
 *
 *   把默认值定成开，是因为绝大多数部署（自己用、演示、小团队）要的就是
 *   「装上就能注册」。要关掉它的那类部署（对外网暴露的内部实例）本来
 *   就在写部署配置，多写一行不是负担。
 *
 * ★★ 认不出来的取值一律当**关**，并且在启动日志里说清楚。
 *
 *   这是一个安全开关，它的两种失败方式代价差得很远：
 *   写成 `flase` 却当成开，是运维明明想关、结果一直开着，而且没有任何
 *   迹象；写成 `ture` 却当成关，表现是「注册按钮不见了」——
 *   有人会当场报上来。前一种是静默的安全回退，后一种只是麻烦。
 *   所以宁可错在关上。
 */

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);

export interface SignupSwitch {
  enabled: boolean;
  /** 给启动日志用的一句人话 */
  reason: string;
}

export function signupSwitch(): SignupSwitch {
  const raw = process.env['APOS_ALLOW_SIGNUP'];

  if (raw === undefined || raw.trim() === '') {
    return { enabled: true, reason: '未配置 APOS_ALLOW_SIGNUP，按默认开启' };
  }

  const value = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(value)) {
    return { enabled: true, reason: `APOS_ALLOW_SIGNUP=${raw}` };
  }
  if (FALSE_VALUES.has(value)) {
    return { enabled: false, reason: `APOS_ALLOW_SIGNUP=${raw}` };
  }

  return {
    enabled: false,
    reason:
      `APOS_ALLOW_SIGNUP=${raw} 认不出来，已按**关闭**处理。` +
      `可用取值：${[...TRUE_VALUES].join('/')} 或 ${[...FALSE_VALUES].join('/')}`,
  };
}

export function signupEnabled(): boolean {
  return signupSwitch().enabled;
}

/**
 * 关着时挡下注册。
 *
 * ★ 用 FORBIDDEN 而不是 NOT_FOUND：这条路存在，只是这个实例把它关了。
 *   回 404 会让排查的人去怀疑版本、路由、反向代理，而真正的原因
 *   是一行环境变量。
 */
export function assertSignupEnabled(): void {
  if (signupEnabled()) return;
  throw fail('FORBIDDEN', 'auth.signup_disabled', '这个实例没有开放自助注册。请联系管理员给你开一个账号，或把你加进已有组织');
}

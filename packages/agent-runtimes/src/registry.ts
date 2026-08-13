import { DEGRADATION_MATRIX, type CapabilityManifest, type FeatureKey } from '@apos/contracts';
import type { AgentRuntimeAdapter } from './adapter';

export class RuntimeRegistry {
  private adapters = new Map<string, AgentRuntimeAdapter>();

  register(id: string, adapter: AgentRuntimeAdapter) {
    this.adapters.set(id, adapter);
  }

  get(id: string): AgentRuntimeAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`未注册的 Agent 运行时: ${id}`);
    return a;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }
}

export interface CompatibilityReport {
  supported: FeatureKey[];
  missing: {
    feature: FeatureKey;
    behavior: string;
    /** 英文对照，原样透传到界面；缺省时前端回落中文 */
    /** English counterpart, passed through untouched; the UI falls back to zh */
    behaviorEn?: string;
    userImpact: string;
    userImpactEn?: string;
    severity: 'info' | 'warning' | 'critical';
  }[];
  /**
   * 存在 critical 缺失时为 true —— 该运行时不应用于高风险任务。
   * True when a critical capability is missing: this runtime must not take
   * high-risk work.
   */
  restricted: boolean;
}

/**
 * 能力兼容性检查 —— 页面文档 14 §5.4 直接展示这份报告。
 *
 * 不静默降级：缺什么能力、会有什么影响，都要让用户看见。
 *
 * The capability compatibility check — page doc 14 §5.4 shows this report
 * verbatim.
 *
 * Nothing degrades silently: which capability is missing, and what it costs
 * the user, are both made visible.
 */
export function checkCompatibility(manifest: CapabilityManifest): CompatibilityReport {
  const supported: FeatureKey[] = [];
  const missing: CompatibilityReport['missing'] = [];

  for (const [key, enabled] of Object.entries(manifest.features) as [FeatureKey, boolean][]) {
    if (enabled) {
      supported.push(key);
      continue;
    }
    const d = DEGRADATION_MATRIX[key];
    missing.push({
      feature: key,
      behavior: d.behavior,
      ...(d.behaviorEn ? { behaviorEn: d.behaviorEn } : {}),
      userImpact: d.userImpact,
      ...(d.userImpactEn ? { userImpactEn: d.userImpactEn } : {}),
      severity: d.severity,
    });
  }

  return {
    supported,
    missing,
    restricted: missing.some((m) => m.severity === 'critical'),
  };
}

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
    userImpact: string;
    severity: 'info' | 'warning' | 'critical';
  }[];
  /** 存在 critical 缺失时为 true —— 该运行时不应用于高风险任务 */
  restricted: boolean;
}

/**
 * 能力兼容性检查 —— 页面文档 14 §5.4 直接展示这份报告。
 *
 * 不静默降级：缺什么能力、会有什么影响，都要让用户看见。
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
      userImpact: d.userImpact,
      severity: d.severity,
    });
  }

  return {
    supported,
    missing,
    restricted: missing.some((m) => m.severity === 'critical'),
  };
}

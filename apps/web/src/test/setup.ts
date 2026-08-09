import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

/**
 * ★ globals: false 时 Testing Library 不会自动注册 cleanup，
 *   DOM 会在测试之间累积 —— 表现为「找到多个同名元素」，
 *   而且是从上一个用例漏过来的，非常误导。必须显式清理。
 */
afterEach(cleanup);

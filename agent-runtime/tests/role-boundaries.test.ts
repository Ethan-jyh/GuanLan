import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EVOLUTION_SYSTEM_PROMPT } from '../src/prompts/evolution.js';
import { FEEDBACK_SYSTEM_PROMPT } from '../src/prompts/feedback.js';
import { ResearchRole } from '../src/contracts/research.js';

describe('Role Prompts and Boundaries', () => {
  it('Evolution prompt should emphasize metric, window, and phase transitions without fabricated data', () => {
    assert.ok(EVOLUTION_SYSTEM_PROMPT.includes('舆情演化'));
    assert.ok(EVOLUTION_SYSTEM_PROMPT.includes('指标定义'));
    assert.ok(EVOLUTION_SYSTEM_PROMPT.includes('时间序列'));
    assert.ok(EVOLUTION_SYSTEM_PROMPT.includes('转折点'));
  });

  it('Feedback prompt should enforce sample size, denominator explanation, and sentiment breakdown', () => {
    assert.ok(FEEDBACK_SYSTEM_PROMPT.includes('公众反馈'));
    assert.ok(FEEDBACK_SYSTEM_PROMPT.includes('分母'));
    assert.ok(FEEDBACK_SYSTEM_PROMPT.includes('去重'));
    assert.ok(FEEDBACK_SYSTEM_PROMPT.includes('诉求'));
  });
});

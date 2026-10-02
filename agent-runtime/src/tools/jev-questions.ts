/**
 * Jev 情感分类问题定义与 Prompt 规范
 */

export const JEV_SENTIMENT_QUESTION_VERSION = 'jev-sentiment-choice-v1';

export interface JevQuestionDefinition {
  type: 'choice';
  options: string[];
  instructions: string;
}

export const JEV_SENTIMENT_QUESTION: JevQuestionDefinition = {
  type: 'choice',
  options: ['positive', 'neutral', 'negative', 'mixed', 'insufficient'],
  instructions:
    '请只判断文本（text）对于评价目标（target）的态度。选项定义：' +
    'positive: 对目标明确赞同、认可、满意或感谢；' +
    'neutral: 对目标为可识别但不偏正负的客观事实/信息陈述；' +
    'negative: 对目标表达不满、批评、质疑、愤怒或反对；' +
    'mixed: 对目标同时存在明确正负两方面评价；' +
    'insufficient: 与目标无直接关联、指代不明、信息极少或无法判断。' +
    '注意：背景信息（context）仅用于辅助消除代词歧义，不得用背景情感替代文本自身对目标的态度。',
};

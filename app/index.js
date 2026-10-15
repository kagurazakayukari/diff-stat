import { defineApp } from './sdk/app-contract/server-client.js';
import { createReview } from './review.js';

export const name = 'diff-stat';

export async function setupApp(sdk) {
  const review = await createReview(sdk);
  await review.attachRoutes();

  // 钩子失败要报告诊断，不能阻断用户原本的文件编辑；旧运行上下文失效时跳过该次回调。
  const observe = (phase, work) => async (invocation) => {
    try { await work(invocation); }
    catch (error) { await sdk.logger.warn(`diff-stat ${phase}: ${error.code || ''} ${error.message}`); }
    return undefined;
  };
  await sdk.hooks.onDecision('agent/before-start', observe('回合开始', review.started));
  await sdk.hooks.onDecision('tools/pre-execute', observe('快照', review.before));
  await sdk.hooks.onDecision('tools/post-execute', observe('采集', review.after));
  await sdk.hooks.on('agent/settled', observe('发布', review.settled));
  await sdk.logger.info('diff-stat 0.25.0 loaded');
}

export default defineApp(setupApp);

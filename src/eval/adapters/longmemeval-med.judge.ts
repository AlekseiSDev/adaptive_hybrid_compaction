// LongMemEval LLM judge. Per docs/design/D_assistant-traj.md §9 (eval axes /
// passive recall) + D5 plan Step 2.
//
// 5 task-type-specific prompt templates copied verbatim from upstream MIT-licensed
// `references/mle-harness/code/judge.py:13-66` (originally from
// github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py
// commit d6dc8b5, Nov 2024). Judge output: binary "yes" / "no" → score 1 / 0
// via `parseYesNo` from shared judge core.

import { join } from 'node:path'
import { createOpenRouterClient } from '../llm.js'
import type { LLMClient, LLMMessage, LLMRequest } from '../types.js'
import { parseYesNo, runJudgeRequest } from './_judge-core.js'

export type LongMemEvalQuestionType =
  | 'single-session-user'
  | 'single-session-assistant'
  | 'multi-session'
  | 'temporal-reasoning'
  | 'knowledge-update'
  | 'single-session-preference'

export type LongMemEvalTask = {
  question_id: string
  question_type: LongMemEvalQuestionType
  haystack_sessions: { role: string; content: string }[][]
  haystack_session_ids?: string[]
  haystack_dates?: string[]
  question: string
  answer: string
}

export const LME_JUDGE_DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6'

const TPL_BASE = (q: string, a: string, r: string): string =>
  `I will give you a question, a correct answer, and a response from a model. ` +
  `Please answer yes if the response contains the correct answer. Otherwise, ` +
  `answer no. If the response is equivalent to the correct answer or contains ` +
  `all the intermediate steps to get the correct answer, you should also answer ` +
  `yes. If the response only contains a subset of the information required by ` +
  `the answer, answer no. \n\n Question: ${q}\n\n Correct Answer: ${a}\n\n Model ` +
  `Response: ${r}\n\n Is the model response correct? Answer yes or no only.`

const TPL_TEMPORAL = (q: string, a: string, r: string): string =>
  `I will give you a question, a correct answer, and a response from a model. ` +
  `Please answer yes if the response contains the correct answer. Otherwise, ` +
  `answer no. If the response is equivalent to the correct answer or contains ` +
  `all the intermediate steps to get the correct answer, you should also answer ` +
  `yes. If the response only contains a subset of the information required by ` +
  `the answer, answer no. In addition, do not penalize off-by-one errors for the ` +
  `number of days. If the question asks for the number of days/weeks/months, ` +
  `etc., and the model makes off-by-one errors (e.g., predicting 19 days when ` +
  `the answer is 18), the model's response is still correct. \n\n Question: ${q}` +
  `\n\n Correct Answer: ${a}\n\n Model Response: ${r}\n\n Is the model response ` +
  `correct? Answer yes or no only.`

const TPL_KU = (q: string, a: string, r: string): string =>
  `I will give you a question, a correct answer, and a response from a model. ` +
  `Please answer yes if the response contains the correct answer. Otherwise, ` +
  `answer no. If the response contains some previous information along with an ` +
  `updated answer, the response should be considered as correct as long as the ` +
  `updated answer is the required answer.\n\n Question: ${q}\n\n Correct Answer: ` +
  `${a}\n\n Model Response: ${r}\n\n Is the model response correct? Answer yes or ` +
  `no only.`

const TPL_PREF = (q: string, a: string, r: string): string =>
  `I will give you a question, a rubric for desired personalized response, and ` +
  `a response from a model. Please answer yes if the response satisfies the ` +
  `desired response. Otherwise, answer no. The model does not need to reflect ` +
  `all the points in the rubric. The response is correct as long as it recalls ` +
  `and utilizes the user's personal information correctly.\n\n Question: ${q}` +
  `\n\n Rubric: ${a}\n\n Model Response: ${r}\n\n Is the model response correct? ` +
  `Answer yes or no only.`

const TPL_ABSTAIN = (q: string, a: string, r: string): string =>
  `I will give you an unanswerable question, an explanation, and a response ` +
  `from a model. Please answer yes if the model correctly identifies the ` +
  `question as unanswerable. The model could say that the information is ` +
  `incomplete, or some other information is given but the asked information ` +
  `is not.\n\n Question: ${q}\n\n Explanation: ${a}\n\n Model Response: ${r}\n\n ` +
  `Does the model correctly identify the question as unanswerable? Answer yes ` +
  `or no only.`

export function selectJudgeTemplate(
  questionType: LongMemEvalQuestionType,
  questionId: string,
): (q: string, a: string, r: string) => string {
  if (questionId.endsWith('_abs')) return TPL_ABSTAIN
  switch (questionType) {
    case 'single-session-user':
    case 'single-session-assistant':
    case 'multi-session':
      return TPL_BASE
    case 'temporal-reasoning':
      return TPL_TEMPORAL
    case 'knowledge-update':
      return TPL_KU
    case 'single-session-preference':
      return TPL_PREF
  }
}

export function buildLmeJudgeRequest(
  task: LongMemEvalTask,
  responseText: string,
  model: string = LME_JUDGE_DEFAULT_MODEL,
): LLMRequest {
  const tpl = selectJudgeTemplate(task.question_type, task.question_id)
  const prompt = tpl(task.question, task.answer, responseText)
  const messages: LLMMessage[] = [{ role: 'user', content: prompt }]
  return { model, messages, temperature: 0, max_tokens: 10 }
}

function judgeCachePath(): string {
  return join(process.cwd(), 'benchmarks/longmemeval/judge_cache.json')
}

export type LmeJudgeDeps = {
  llmClient: LLMClient
  model?: string
  persist?: boolean
}

export async function lmeJudge(
  task: LongMemEvalTask,
  responseText: string,
  deps: LmeJudgeDeps,
): Promise<{ score: number; justification: string; cost_usd: number }> {
  const model = deps.model ?? LME_JUDGE_DEFAULT_MODEL
  const request = buildLmeJudgeRequest(task, responseText, model)
  return runJudgeRequest(task.question_id, request, {
    llmClient: deps.llmClient,
    cachePath: judgeCachePath(),
    ...(deps.persist !== undefined ? { persist: deps.persist } : {}),
    parseFn: parseYesNo,
  })
}

export type LmeLlmJudgeFn = (
  task: LongMemEvalTask,
  responseText: string,
) => Promise<{ score: number; justification: string; cost_usd: number }>

export function defaultLmeJudge(opts: { apiKey?: string; model?: string } = {}): LmeLlmJudgeFn {
  const apiKey = opts.apiKey ?? process.env['OPENROUTER_API_KEY']
  if (!apiKey || apiKey.length === 0) {
    throw new Error(
      'OPENROUTER_API_KEY env var is required for bench=longmemeval-med judge.',
    )
  }
  const llmClient = createOpenRouterClient({ apiKey, appName: 'AHC' })
  const model = opts.model ?? LME_JUDGE_DEFAULT_MODEL
  return async (task, responseText) => lmeJudge(task, responseText, { llmClient, model })
}

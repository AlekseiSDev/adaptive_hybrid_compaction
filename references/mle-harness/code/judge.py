"""LongMemEval judge — verbatim prompt templates from
https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py
(commit d6dc8b5, Nov 2024).

We use gpt-4o-2024-08-06 (the paper's headline judge) via OpenRouter.
"""
from __future__ import annotations

from llm_client import LLMClient


# Verbatim prompts copied from the canonical evaluate_qa.py
_TPL_BASE = (
    "I will give you a question, a correct answer, and a response from a model. "
    "Please answer yes if the response contains the correct answer. Otherwise, "
    "answer no. If the response is equivalent to the correct answer or contains "
    "all the intermediate steps to get the correct answer, you should also answer "
    "yes. If the response only contains a subset of the information required by "
    "the answer, answer no. \n\n Question: {}\n\n Correct Answer: {}\n\n Model "
    "Response: {}\n\n Is the model response correct? Answer yes or no only."
)

_TPL_TEMPORAL = (
    "I will give you a question, a correct answer, and a response from a model. "
    "Please answer yes if the response contains the correct answer. Otherwise, "
    "answer no. If the response is equivalent to the correct answer or contains "
    "all the intermediate steps to get the correct answer, you should also answer "
    "yes. If the response only contains a subset of the information required by "
    "the answer, answer no. In addition, do not penalize off-by-one errors for the "
    "number of days. If the question asks for the number of days/weeks/months, "
    "etc., and the model makes off-by-one errors (e.g., predicting 19 days when "
    "the answer is 18), the model's response is still correct. \n\n Question: {}"
    "\n\n Correct Answer: {}\n\n Model Response: {}\n\n Is the model response "
    "correct? Answer yes or no only."
)

_TPL_KU = (
    "I will give you a question, a correct answer, and a response from a model. "
    "Please answer yes if the response contains the correct answer. Otherwise, "
    "answer no. If the response contains some previous information along with an "
    "updated answer, the response should be considered as correct as long as the "
    "updated answer is the required answer.\n\n Question: {}\n\n Correct Answer: "
    "{}\n\n Model Response: {}\n\n Is the model response correct? Answer yes or "
    "no only."
)

_TPL_PREF = (
    "I will give you a question, a rubric for desired personalized response, and "
    "a response from a model. Please answer yes if the response satisfies the "
    "desired response. Otherwise, answer no. The model does not need to reflect "
    "all the points in the rubric. The response is correct as long as it recalls "
    "and utilizes the user's personal information correctly.\n\n Question: {}"
    "\n\n Rubric: {}\n\n Model Response: {}\n\n Is the model response correct? "
    "Answer yes or no only."
)

_TPL_ABSTAIN = (
    "I will give you an unanswerable question, an explanation, and a response "
    "from a model. Please answer yes if the model correctly identifies the "
    "question as unanswerable. The model could say that the information is "
    "incomplete, or some other information is given but the asked information "
    "is not.\n\n Question: {}\n\n Explanation: {}\n\n Model Response: {}\n\n "
    "Does the model correctly identify the question as unanswerable? Answer yes "
    "or no only."
)


def get_anscheck_prompt(task: str, question: str, answer: str, response: str, abstention: bool = False) -> str:
    if abstention:
        return _TPL_ABSTAIN.format(question, answer, response)
    if task in ("single-session-user", "single-session-assistant", "multi-session"):
        return _TPL_BASE.format(question, answer, response)
    if task == "temporal-reasoning":
        return _TPL_TEMPORAL.format(question, answer, response)
    if task == "knowledge-update":
        return _TPL_KU.format(question, answer, response)
    if task == "single-session-preference":
        return _TPL_PREF.format(question, answer, response)
    raise NotImplementedError(f"unknown task type: {task}")


async def judge_one(
    llm: LLMClient,
    *,
    task: str,
    question: str,
    answer: str,
    response: str,
    question_id: str,
    abstention: bool = False,
    judge_model: str = "openai/gpt-4o-2024-08-06",
    experiment: str = "",
    strategy: str = "",
) -> tuple[bool, str]:
    prompt = get_anscheck_prompt(task, question, answer, response, abstention)
    res = await llm.complete(
        model=judge_model,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.0,
        max_tokens=10,
        experiment=experiment,
        item_id=question_id,
        strategy=strategy,
        call_kind="judge",
    )
    label = "yes" in res.text.lower()
    return label, res.text

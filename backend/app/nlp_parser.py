import json
import os
import re
from typing import Any, Dict, List, Optional

from app.schemas import (
    ActionSpec,
    ConditionRule,
    ParseInstructionResponse,
    WorkflowDefinitionSchema,
    WorkflowStep,
)


def _detect_ambiguity(
    instruction: str,
    clarifications: Optional[Dict[str, Any]] = None,
) -> Optional[ParseInstructionResponse]:
    clar = clarifications or {}
    text = instruction.strip()
    lower = text.lower()
    clar_answer = str(clar.get("clarification_answer", "")).strip().lower()
    combined = f"{lower} {clar_answer}".strip()

    # 1. Detect unsupported criteria like "years of experience" when no clarification answer has been given yet
    if ("year" in lower and "experience" in lower) and not clar_answer:
        return ParseInstructionResponse(
            status="clarification_needed",
            clarification_question=(
                "Our candidate profiles currently track AI Resume Score (0–100), Role, Prescreen status, "
                "Interest, Notice Period (days), and AI Phone Interview Score (0–100)—not years of experience. "
                "Which thresholds and actions would you like to use instead (for example: 'Resume score above 75, "
                "trigger AI prescreen call, and email recruiter if passed')?"
            ),
            missing_fields=["supported_criteria", "actions"],
            raw_preview_summary="Waiting for supported candidate criteria and actions.",
        )

    # 2. Check if the instruction mentions neither a known condition nor any workflow action
    known_keywords = [
        "resume",
        "score",
        "prescreen",
        "whatsapp",
        "interview",
        "email",
        "notice",
        "interested",
        "role",
        "engineer",
        "developer",
    ]
    if not any(kw in combined for kw in known_keywords):
        return ParseInstructionResponse(
            status="clarification_needed",
            clarification_question=(
                "I didn't see specific screening rules or actions in that request. "
                "Tell me which candidates to select (e.g., AI Resume Score > 70 or notice period < 30 days) "
                "and what actions to run (AI prescreen call, WhatsApp questionnaire, AI phone interview, or email alert)."
            ),
            missing_fields=["conditions", "actions"],
            raw_preview_summary="Waiting for candidate selection rules and actions.",
        )

    # 3. Vague threshold phrases without numbers
    vague_score_phrases = [
        "high score",
        "low score",
        "good score",
        "weak candidates",
        "strong candidates",
        "short notice",
    ]
    has_number = bool(re.search(r"\b\d+(\.\d+)?\b", combined))

    if not has_number and any(phrase in combined for phrase in vague_score_phrases):
        return ParseInstructionResponse(
            status="clarification_needed",
            clarification_question=(
                "What exact numeric threshold should I apply (for example: AI Resume Score > 70, "
                "notice period < 30 days, or AI Phone Interview Score > 60)?"
            ),
            missing_fields=["threshold"],
            raw_preview_summary="Waiting for numeric threshold clarification.",
        )

    # 4. Email requested without specifying recipients
    if "email" in combined and "recruiter" not in combined and "hiring manager" not in combined and "@" not in combined:
        return ParseInstructionResponse(
            status="clarification_needed",
            clarification_question=(
                "Who should receive the email alert—the recruiter, the Hiring Manager, or both?"
            ),
            missing_fields=["recipients"],
            raw_preview_summary="Waiting for email recipient clarification.",
        )

    return None


def _build_default_example_workflow(instruction: str) -> WorkflowDefinitionSchema:
    return WorkflowDefinitionSchema(
        workflow_name="Full Screening & Interview Flow",
        entry_step_id="s1",
        requires_confirmation=True,
        steps=[
            WorkflowStep(
                step_id="s1",
                step_type="filter",
                description="Select candidates with AI Resume Score > 70",
                condition=ConditionRule(field="resume_score", operator=">", value=70),
                on_true="s2",
                on_false="REJECT",
            ),
            WorkflowStep(
                step_id="s2",
                step_type="action",
                description="Trigger AI prescreen phone call",
                action=ActionSpec(
                    action_type="ai_prescreen_call",
                    recipients=["candidate"],
                    template_or_prompt="Conduct initial AI prescreen call and evaluate fit.",
                ),
                next_step="s3",
            ),
            WorkflowStep(
                step_id="s3",
                step_type="branch",
                description="Check if candidate passed AI prescreen call",
                condition=ConditionRule(field="prescreen_passed", operator="==", value=True),
                on_true="s5",
                on_false="s4",
            ),
            WorkflowStep(
                step_id="s4",
                step_type="action",
                description="Send WhatsApp questionnaire on interest and notice period",
                action=ActionSpec(
                    action_type="whatsapp_questionnaire",
                    recipients=["candidate"],
                    template_or_prompt="Are you still interested in this role and what is your notice period in days?",
                ),
                next_step="s5",
            ),
            WorkflowStep(
                step_id="s5",
                step_type="branch",
                description="Check if candidate is interested AND notice period < 30 days",
                condition=ConditionRule(
                    field="interested",
                    operator="==",
                    value=True,
                    combine_with="AND",
                    next_condition=ConditionRule(field="notice_period_days", operator="<", value=30),
                ),
                on_true="s6",
                on_false="END",
            ),
            WorkflowStep(
                step_id="s6",
                step_type="action",
                description="Trigger AI Phone Interview",
                action=ActionSpec(
                    action_type="ai_phone_interview",
                    recipients=["candidate"],
                    template_or_prompt="Conduct structured AI Phone Interview and score response.",
                ),
                next_step="s7",
            ),
            WorkflowStep(
                step_id="s7",
                step_type="branch",
                description="Check if AI Phone Interview Score > 60",
                condition=ConditionRule(field="phone_interview_score", operator=">", value=60),
                on_true="s8",
                on_false="END",
            ),
            WorkflowStep(
                step_id="s8",
                step_type="action",
                description="Send email alert to recruiter and Hiring Manager",
                action=ActionSpec(
                    action_type="email_alert",
                    recipients=["recruiter", "hiring_manager"],
                    template_or_prompt=f"Candidate qualified from workflow: {instruction[:120]}",
                ),
                next_step="END",
            ),
        ],
    )


def _rule_based_fallback_workflow(
    instruction: str,
    clarifications: Optional[Dict[str, Any]] = None,
) -> WorkflowDefinitionSchema:
    lower = instruction.lower()
    clar_text = str((clarifications or {}).get("clarification_answer", "")).lower()
    combined = f"{lower} {clar_text}".strip()

    resume_match = re.search(
        r"resume\s*score[^0-9<>=-]*(?:above|over|greater than|>|>=)?\s*(\d+(?:\.\d+)?)",
        combined,
    )
    resume_threshold = float(resume_match.group(1)) if resume_match else 70.0

    notice_match = re.search(
        r"notice\s*period[^0-9<>=-]*(?:below|under|less than|<|<=)?\s*(\d+)",
        combined,
    )
    notice_threshold = int(notice_match.group(1)) if notice_match else 30

    interview_match = re.search(
        r"(?:phone\s*interview|interview)\s*score[^0-9<>=-]*(?:above|over|greater than|>|>=)?\s*(\d+(?:\.\d+)?)",
        combined,
    )
    interview_threshold = float(interview_match.group(1)) if interview_match else 60.0

    has_prescreen = "prescreen" in combined
    has_whatsapp = "whatsapp" in combined
    has_interview = "phone interview" in combined or "interview" in combined
    has_email = "email" in combined

    # Build a tailored workflow when the prompt specifies a focused subset of actions
    if not has_prescreen and (has_whatsapp or has_interview or has_email):
        steps: List[WorkflowStep] = []
        steps.append(
            WorkflowStep(
                step_id="s1",
                step_type="filter",
                description=f"Filter candidates with AI Resume Score > {resume_threshold}",
                condition=ConditionRule(field="resume_score", operator=">", value=resume_threshold),
                on_true="s2",
                on_false="REJECT",
            )
        )

        next_idx = 2
        if "notice" in combined:
            curr_id = f"s{next_idx}"
            next_idx += 1
            steps.append(
                WorkflowStep(
                    step_id=curr_id,
                    step_type="branch",
                    description=f"Check if notice period < {notice_threshold} days",
                    condition=ConditionRule(
                        field="notice_period_days",
                        operator="<",
                        value=notice_threshold,
                    ),
                    on_true=f"s{next_idx}",
                    on_false="END",
                )
            )

        if has_whatsapp:
            curr_id = f"s{next_idx}"
            next_idx += 1
            has_more = has_interview or has_email
            steps.append(
                WorkflowStep(
                    step_id=curr_id,
                    step_type="action",
                    description="Send WhatsApp questionnaire to check interest & HR details",
                    action=ActionSpec(
                        action_type="whatsapp_questionnaire",
                        recipients=["candidate"],
                        template_or_prompt="Please confirm your interest and notice period in days.",
                    ),
                    next_step=f"s{next_idx}" if has_more else "END",
                )
            )

        if has_interview:
            curr_id = f"s{next_idx}"
            next_idx += 1
            steps.append(
                WorkflowStep(
                    step_id=curr_id,
                    step_type="action",
                    description="Trigger AI Phone Interview",
                    action=ActionSpec(
                        action_type="ai_phone_interview",
                        recipients=["candidate"],
                        template_or_prompt="Conduct AI Phone Interview and record score.",
                    ),
                    next_step=f"s{next_idx}",
                )
            )
            branch_id = f"s{next_idx}"
            next_idx += 1
            steps.append(
                WorkflowStep(
                    step_id=branch_id,
                    step_type="branch",
                    description=f"Check if AI Phone Interview Score > {interview_threshold}",
                    condition=ConditionRule(
                        field="phone_interview_score",
                        operator=">",
                        value=interview_threshold,
                    ),
                    on_true=f"s{next_idx}" if has_email else "END",
                    on_false="END",
                )
            )

        if has_email:
            curr_id = f"s{next_idx}"
            recipients: List[str] = []
            if "hiring manager" in combined:
                recipients.append("hiring_manager")
            if "recruiter" in combined or not recipients:
                recipients.append("recruiter")
            steps.append(
                WorkflowStep(
                    step_id=curr_id,
                    step_type="action",
                    description=f"Send email alert to {', '.join(recipients)}",
                    action=ActionSpec(
                        action_type="email_alert",
                        recipients=recipients,
                        template_or_prompt=f"Candidate matched workflow: {instruction[:120]}",
                    ),
                    next_step="END",
                )
            )

        return WorkflowDefinitionSchema(
            workflow_name="Custom Recruiter Workflow",
            entry_step_id="s1",
            requires_confirmation=True,
            steps=steps,
        )

    wf = _build_default_example_workflow(instruction)
    wf.steps[0].condition = ConditionRule(field="resume_score", operator=">", value=resume_threshold)
    wf.steps[0].description = f"Select candidates with AI Resume Score > {resume_threshold}"

    for step in wf.steps:
        if step.step_id == "s5" and step.condition and step.condition.next_condition:
            step.condition.next_condition.value = notice_threshold
            step.description = f"Interested AND notice period < {notice_threshold} days"
        if step.step_id == "s7" and step.condition:
            step.condition.value = interview_threshold
            step.description = f"Check if AI Phone Interview Score > {interview_threshold}"

    return wf


def _call_gemini_for_workflow(
    instruction: str,
    clarifications: Optional[Dict[str, Any]] = None,
) -> Optional[ParseInstructionResponse]:
    api_key = os.getenv("LLM_API_KEY") or os.getenv("GEMINI_API_KEY")
    if not api_key or api_key.startswith("your_"):
        return None

    try:
        from google import genai
        from google.genai import types
    except ImportError:
        return None

    model_name = os.getenv("LLM_MODEL", "gemini-2.5-flash")
    client = genai.Client(api_key=api_key)

    system_prompt = """
You are an NLP workflow compiler for a recruitment automation system.
Convert the recruiter's natural-language instruction into a JSON object matching ParseInstructionResponse:
- status: "workflow_ready" or "clarification_needed"
- clarification_question: string if status == "clarification_needed", else null
- missing_fields: list of strings if clarification_needed
- workflow: object matching WorkflowDefinitionSchema if status == "workflow_ready", else null

Allowed candidate fields:
resume_score (number 0-100), prescreen_passed (boolean), interested (boolean),
notice_period_days (number 0-365), phone_interview_score (number 0-100), role (string).

Allowed operators: ">", ">=", "<", "<=", "==", "!=".
Allowed step_type: "filter", "branch", "action".
Allowed action_type: "ai_prescreen_call", "whatsapp_questionnaire", "ai_phone_interview", "email_alert".
Allowed target IDs for on_true, on_false, next_step: any valid step_id in steps, or "END", or "REJECT".

Never output executable code. If an essential numeric threshold, supported candidate field, or recipient is missing/ambiguous and not answered in clarifications, set status="clarification_needed".
"""

    user_content = f"Instruction: {instruction}\nClarifications: {json.dumps(clarifications or {})}"

    try:
        response = client.models.generate_content(
            model=model_name,
            contents=user_content,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
                response_mime_type="application/json",
                response_schema=ParseInstructionResponse,
                temperature=0.1,
            ),
        )
        if response.parsed and isinstance(response.parsed, ParseInstructionResponse):
            return response.parsed
        if response.text:
            return ParseInstructionResponse.model_validate_json(response.text)
    except Exception:
        return None

    return None


def parse_recruiter_instruction(
    instruction: str,
    clarifications: Optional[Dict[str, Any]] = None,
) -> ParseInstructionResponse:
    if not instruction or not instruction.strip():
        return ParseInstructionResponse(
            status="invalid_request",
            clarification_question="Please enter a recruitment instruction first.",
            missing_fields=["instruction"],
        )

    ambiguous = _detect_ambiguity(instruction, clarifications)
    if ambiguous is not None:
        return ambiguous

    llm_result = _call_gemini_for_workflow(instruction, clarifications)
    if llm_result is not None:
        if not llm_result.raw_preview_summary and llm_result.workflow:
            llm_result.raw_preview_summary = (
                f"Prepared '{llm_result.workflow.workflow_name}' ({len(llm_result.workflow.steps)} steps)."
            )
        return llm_result

    fallback_wf = _rule_based_fallback_workflow(instruction, clarifications)
    return ParseInstructionResponse(
        status="workflow_ready",
        workflow=fallback_wf,
        raw_preview_summary=f"Prepared '{fallback_wf.workflow_name}' ({len(fallback_wf.steps)} steps).",
        extra_context={"parser_mode": "deterministic_fallback"},
    )
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.adapters.mock_channels import (
    MockEmailAdapter,
    MockTelephonyAdapter,
    MockWhatsAppAdapter,
)
from app.models import (
    AuditLog,
    Candidate,
    CandidateStepState,
    WorkflowDefinition,
    WorkflowRun,
)
from app.schemas import ConditionRule, WorkflowDefinitionSchema, WorkflowStep


def utc_now():
    return datetime.now(timezone.utc)


def _compare_single(actual: Any, operator: str, target: Any) -> bool:
    if actual is None:
        return False

    if operator == "==":
        return actual == target
    if operator == "!=":
        return actual != target

    try:
        actual_num = float(actual)
        target_num = float(target)
    except (TypeError, ValueError):
        return False

    if operator == ">":
        return actual_num > target_num
    if operator == ">=":
        return actual_num >= target_num
    if operator == "<":
        return actual_num < target_num
    if operator == "<=":
        return actual_num <= target_num

    return False


def evaluate_condition(rule: ConditionRule, candidate: Candidate) -> bool:
    actual = getattr(candidate, rule.field, None)
    current_result = _compare_single(actual, rule.operator, rule.value)

    if rule.combine_with and rule.next_condition:
        next_result = evaluate_condition(rule.next_condition, candidate)
        if rule.combine_with == "AND":
            return current_result and next_result
        if rule.combine_with == "OR":
            return current_result or next_result

    return current_result


class WorkflowEngine:
    def __init__(self, db: Session, simulate_failure: bool = False):
        self.db = db
        self.simulate_failure = simulate_failure
        self.prescreen_adapter = MockTelephonyAdapter(mode="prescreen")
        self.phone_interview_adapter = MockTelephonyAdapter(mode="phone_interview")
        self.whatsapp_adapter = MockWhatsAppAdapter()
        self.email_adapter = MockEmailAdapter()

    def log_audit(
        self,
        event_type: str,
        details: Dict[str, Any],
        run_id: Optional[int] = None,
        workflow_id: Optional[int] = None,
        candidate_id: Optional[int] = None,
        actor: str = "system",
    ) -> None:
        entry = AuditLog(
            run_id=run_id,
            workflow_id=workflow_id,
            candidate_id=candidate_id,
            event_type=event_type,
            actor=actor,
            details_json=json.dumps(details, default=str),
        )
        self.db.add(entry)
        self.db.commit()

    def _has_already_executed(self, run_id: int, candidate_id: int, step_id: str, action_type: str) -> bool:
        existing = (
            self.db.query(AuditLog)
            .filter(
                AuditLog.run_id == run_id,
                AuditLog.candidate_id == candidate_id,
                AuditLog.event_type == "ACTION_COMPLETED",
            )
            .all()
        )
        for row in existing:
            try:
                data = json.loads(row.details_json)
                if data.get("step_id") == step_id and data.get("action_type") == action_type:
                    return True
            except json.JSONDecodeError:
                continue
        return False

    def _resolve_recipient(self, recipient_token: str, candidate: Candidate, action_type: str) -> str:
        token = recipient_token.strip().lower()
        if token in {"candidate", "candidate_phone", "phone"}:
            return candidate.phone or ""
        if token in {"candidate_email"}:
            return candidate.email or ""
        if token == "recruiter":
            return "recruiter.team@transformnxt.example.com"
        if token in {"hiring_manager", "hiring manager"}:
            return "hiring.manager@transformnxt.example.com"
        return recipient_token

    def _execute_action(
        self,
        step: WorkflowStep,
        candidate: Candidate,
        run: WorkflowRun,
    ) -> tuple[bool, str, Optional[str]]:
        assert step.action is not None
        action_type = step.action.action_type

        if self._has_already_executed(run.id, candidate.id, step.step_id, action_type):
            msg = f"[IDEMPOTENT_SKIP] Action '{action_type}' already executed for candidate {candidate.id} at step '{step.step_id}'"
            self.log_audit(
                event_type="ACTION_DUPLICATE_PREVENTED",
                details={"step_id": step.step_id, "action_type": action_type, "message": msg},
                run_id=run.id,
                workflow_id=run.workflow_id,
                candidate_id=candidate.id,
            )
            return True, msg, None

        context = {
            "candidate_id": candidate.id,
            "candidate_name": candidate.name,
            "role": candidate.role,
            "resume_score": candidate.resume_score,
            "prescreen_passed": candidate.prescreen_passed,
            "interested": candidate.interested,
            "notice_period_days": candidate.notice_period_days,
            "phone_interview_score": candidate.phone_interview_score,
        }

        summaries: List[str] = []
        for token in step.action.recipients:
            recipient = self._resolve_recipient(token, candidate, action_type)
            self.log_audit(
                event_type="ACTION_ATTEMPTED",
                details={
                    "step_id": step.step_id,
                    "action_type": action_type,
                    "recipient_token": token,
                    "recipient": recipient,
                    "simulated": True,
                },
                run_id=run.id,
                workflow_id=run.workflow_id,
                candidate_id=candidate.id,
            )

            if action_type == "ai_prescreen_call":
                res = self.prescreen_adapter.send(recipient, step.action.template_or_prompt, context, self.simulate_failure)
            elif action_type == "whatsapp_questionnaire":
                res = self.whatsapp_adapter.send(recipient, step.action.template_or_prompt, context, self.simulate_failure)
            elif action_type == "ai_phone_interview":
                res = self.phone_interview_adapter.send(recipient, step.action.template_or_prompt, context, self.simulate_failure)
            elif action_type == "email_alert":
                body = (
                    f"{step.action.template_or_prompt} | Candidate: {candidate.name} ({candidate.email}), "
                    f"Role: {candidate.role}, Resume Score: {candidate.resume_score}, "
                    f"Phone Interview Score: {candidate.phone_interview_score}"
                )
                res = self.email_adapter.send(recipient, body, context, self.simulate_failure)
            else:
                return False, f"Unsupported action '{action_type}'", "Unsupported action type"

            if not res.success:
                self.log_audit(
                    event_type="ACTION_FAILED",
                    details={
                        "step_id": step.step_id,
                        "action_type": action_type,
                        "recipient": recipient,
                        "error": res.error,
                        "summary": res.summary,
                    },
                    run_id=run.id,
                    workflow_id=run.workflow_id,
                    candidate_id=candidate.id,
                )
                return False, res.summary, res.error

            self.log_audit(
                event_type="ACTION_COMPLETED",
                details={
                    "step_id": step.step_id,
                    "action_type": action_type,
                    "recipient": recipient,
                    "simulated": res.simulated,
                    "summary": res.summary,
                    "metadata": res.metadata,
                },
                run_id=run.id,
                workflow_id=run.workflow_id,
                candidate_id=candidate.id,
            )
            summaries.append(res.summary)

        return True, " | ".join(summaries), None

    def start_run(self, workflow_def: WorkflowDefinition, candidate_ids: Optional[List[int]] = None) -> WorkflowRun:
        if not workflow_def.is_confirmed:
            raise ValueError("Workflow must be explicitly confirmed before execution")

        schema = WorkflowDefinitionSchema.model_validate(json.loads(workflow_def.workflow_json))
        step_map: Dict[str, WorkflowStep] = {s.step_id: s for s in schema.steps}

        query = self.db.query(Candidate)
        if candidate_ids:
            query = query.filter(Candidate.id.in_(candidate_ids))
        candidates = query.order_by(Candidate.id.asc()).all()

        run = WorkflowRun(
            workflow_id=workflow_def.id,
            status="RUNNING",
            total_candidates=len(candidates),
            completed_candidates=0,
        )
        self.db.add(run)
        self.db.commit()
        self.db.refresh(run)

        self.log_audit(
            event_type="RUN_STARTED",
            details={"workflow_name": schema.workflow_name, "total_candidates": len(candidates)},
            run_id=run.id,
            workflow_id=workflow_def.id,
            actor="recruiter",
        )

        states: List[CandidateStepState] = []
        for cand in candidates:
            st = CandidateStepState(
                run_id=run.id,
                candidate_id=cand.id,
                current_step=schema.entry_step_id,
                status="PENDING",
                next_action=step_map[schema.entry_step_id].description,
            )
            self.db.add(st)
            states.append(st)
        self.db.commit()

        self._execute_loop(run, step_map, states)
        return run

    def control_run(self, run_id: int, action: str) -> WorkflowRun:
        run = self.db.query(WorkflowRun).filter(WorkflowRun.id == run_id).first()
        if not run:
            raise ValueError(f"WorkflowRun {run_id} not found")

        workflow_def = self.db.query(WorkflowDefinition).filter(WorkflowDefinition.id == run.workflow_id).first()
        assert workflow_def is not None
        schema = WorkflowDefinitionSchema.model_validate(json.loads(workflow_def.workflow_json))
        step_map: Dict[str, WorkflowStep] = {s.step_id: s for s in schema.steps}

        if action == "pause":
            run.status = "PAUSED"
            self.db.commit()
            self.log_audit("RUN_PAUSED", {"run_id": run.id}, run_id=run.id, workflow_id=run.workflow_id, actor="recruiter")
        elif action == "cancel":
            run.status = "CANCELLED"
            run.completed_at = utc_now()
            for st in run.step_states:
                if st.status in {"PENDING", "IN_PROGRESS"}:
                    st.status = "CANCELLED"
                    st.next_action = None
            self.db.commit()
            self.log_audit("RUN_CANCELLED", {"run_id": run.id}, run_id=run.id, workflow_id=run.workflow_id, actor="recruiter")
        elif action == "resume":
            if run.status != "PAUSED":
                raise ValueError(f"Cannot resume run in status '{run.status}'")
            run.status = "RUNNING"
            self.db.commit()
            self.log_audit("RUN_RESUMED", {"run_id": run.id}, run_id=run.id, workflow_id=run.workflow_id, actor="recruiter")
            self._execute_loop(run, step_map, list(run.step_states))
        else:
            raise ValueError(f"Unsupported control action '{action}'")

        self.db.refresh(run)
        return run

    def _execute_loop(
        self,
        run: WorkflowRun,
        step_map: Dict[str, WorkflowStep],
        states: List[CandidateStepState],
    ) -> None:
        for st in states:
            self.db.refresh(run)
            if run.status in {"PAUSED", "CANCELLED"}:
                return

            if st.status in {"COMPLETED", "SKIPPED", "CANCELLED"}:
                continue

            candidate = self.db.query(Candidate).filter(Candidate.id == st.candidate_id).first()
            assert candidate is not None

            current_step_id = st.current_step
            while current_step_id and current_step_id not in {"END", "REJECT"}:
                self.db.refresh(run)
                if run.status in {"PAUSED", "CANCELLED"}:
                    return

                step = step_map.get(current_step_id)
                if not step:
                    st.status = "FAILED"
                    st.error_message = f"Unknown step '{current_step_id}'"
                    st.next_action = None
                    break

                st.current_step = step.step_id
                st.status = "IN_PROGRESS"
                st.next_action = step.description
                self.db.commit()

                if step.step_type in {"filter", "branch"}:
                    assert step.condition is not None
                    passed = evaluate_condition(step.condition, candidate)
                    outcome_text = f"{step.description} -> {'TRUE' if passed else 'FALSE'}"
                    st.outcome = outcome_text
                    self.log_audit(
                        event_type="CONDITION_EVALUATED",
                        details={
                            "step_id": step.step_id,
                            "step_type": step.step_type,
                            "condition": step.condition.model_dump(),
                            "result": passed,
                        },
                        run_id=run.id,
                        workflow_id=run.workflow_id,
                        candidate_id=candidate.id,
                    )
                    next_target = step.on_true if passed else step.on_false
                    if next_target == "REJECT":
                        st.status = "SKIPPED"
                        st.outcome = f"Filtered out at '{step.step_id}'"
                        st.next_action = None
                        current_step_id = None
                    elif next_target in {None, "END"}:
                        st.status = "COMPLETED"
                        st.next_action = None
                        current_step_id = None
                    else:
                        current_step_id = next_target

                elif step.step_type == "action":
                    ok, summary, err = self._execute_action(step, candidate, run)
                    if not ok:
                        st.status = "FAILED"
                        st.error_message = err or summary
                        st.outcome = summary
                        st.next_action = "Retry or manual follow-up"
                        current_step_id = None
                    else:
                        st.outcome = summary
                        next_target = step.next_step or step.on_true or "END"
                        if next_target in {"END", "REJECT"}:
                            st.status = "COMPLETED" if next_target == "END" else "SKIPPED"
                            st.next_action = None
                            current_step_id = None
                        else:
                            current_step_id = next_target

                self.db.commit()

            if st.status == "IN_PROGRESS":
                st.status = "COMPLETED"
                st.next_action = None
                self.db.commit()

        finished_count = sum(
            1 for s in run.step_states if s.status in {"COMPLETED", "SKIPPED", "FAILED", "CANCELLED"}
        )
        run.completed_candidates = finished_count
        if run.status == "RUNNING":
            run.status = "COMPLETED"
            run.completed_at = utc_now()
            self.log_audit(
                event_type="RUN_COMPLETED",
                details={"run_id": run.id, "completed_candidates": finished_count},
                run_id=run.id,
                workflow_id=run.workflow_id,
            )
        self.db.commit()
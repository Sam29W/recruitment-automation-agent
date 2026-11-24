from typing import Any, Dict, List, Literal, Optional, Union
from pydantic import BaseModel, Field, model_validator


ALLOWED_CANDIDATE_FIELDS = {
    "resume_score",
    "prescreen_passed",
    "interested",
    "notice_period_days",
    "phone_interview_score",
    "role",
}

ALLOWED_OPERATORS = Literal[">", ">=", "<", "<=", "==", "!="]
ALLOWED_ACTION_TYPES = Literal[
    "ai_prescreen_call",
    "whatsapp_questionnaire",
    "ai_phone_interview",
    "email_alert",
]
ALLOWED_STEP_TYPES = Literal["filter", "branch", "action"]


class ConditionRule(BaseModel):
    field: str
    operator: ALLOWED_OPERATORS
    value: Union[float, int, bool, str]
    combine_with: Optional[Literal["AND", "OR"]] = None
    next_condition: Optional["ConditionRule"] = None

    @model_validator(mode="after")
    def validate_field_and_value(self):
        if self.field not in ALLOWED_CANDIDATE_FIELDS:
            raise ValueError(f"Unsupported candidate field: '{self.field}'")

        if self.field in {"resume_score", "phone_interview_score"}:
            if not isinstance(self.value, (int, float)) or isinstance(self.value, bool):
                raise ValueError(f"Field '{self.field}' requires a numeric score")
            if not (0 <= float(self.value) <= 100):
                raise ValueError(f"Score threshold for '{self.field}' must be between 0 and 100")

        if self.field == "notice_period_days":
            if not isinstance(self.value, (int, float)) or isinstance(self.value, bool):
                raise ValueError("Field 'notice_period_days' requires a number of days")
            if float(self.value) < 0 or float(self.value) > 365:
                raise ValueError("Field 'notice_period_days' must be between 0 and 365")

        if self.field in {"prescreen_passed", "interested"}:
            if not isinstance(self.value, bool):
                raise ValueError(f"Field '{self.field}' requires a boolean (true/false)")

        if (self.combine_with is None) != (self.next_condition is None):
            raise ValueError("Both 'combine_with' and 'next_condition' must be provided together")

        return self


class ActionSpec(BaseModel):
    action_type: ALLOWED_ACTION_TYPES
    recipients: List[str] = Field(min_length=1)
    template_or_prompt: str = Field(min_length=3)


class WorkflowStep(BaseModel):
    step_id: str = Field(min_length=1)
    step_type: ALLOWED_STEP_TYPES
    description: str = Field(min_length=3)
    condition: Optional[ConditionRule] = None
    action: Optional[ActionSpec] = None
    on_true: Optional[str] = None
    on_false: Optional[str] = None
    next_step: Optional[str] = None

    @model_validator(mode="after")
    def validate_step_shape(self):
        if self.step_type in {"filter", "branch"} and self.condition is None:
            raise ValueError(f"Step '{self.step_id}' of type '{self.step_type}' requires a 'condition'")
        if self.step_type == "action" and self.action is None:
            raise ValueError(f"Step '{self.step_id}' of type 'action' requires an 'action' spec")
        return self


class WorkflowDefinitionSchema(BaseModel):
    workflow_name: str = Field(min_length=2)
    entry_step_id: str = Field(min_length=1)
    steps: List[WorkflowStep] = Field(min_length=1)
    requires_confirmation: bool = True

    @model_validator(mode="after")
    def validate_graph(self) -> "WorkflowDefinitionSchema":
        step_map: Dict[str, WorkflowStep] = {s.step_id: s for s in self.steps}
        if len(step_map) != len(self.steps):
            raise ValueError("Duplicate step_id found in workflow steps")

        if self.entry_step_id not in step_map:
            raise ValueError(f"entry_step_id '{self.entry_step_id}' does not exist in steps")

        valid_targets = set(step_map.keys()) | {"END", "REJECT"}
        for step in self.steps:
            for target_label, target_id in [
                ("on_true", step.on_true),
                ("on_false", step.on_false),
                ("next_step", step.next_step),
            ]:
                if target_id is not None and target_id not in valid_targets:
                    raise ValueError(
                        f"Step '{step.step_id}' has invalid {target_label} target '{target_id}'"
                    )

        return self


class ParseInstructionResponse(BaseModel):
    status: Literal["workflow_ready", "clarification_needed", "invalid_request"]
    clarification_question: Optional[str] = None
    missing_fields: List[str] = Field(default_factory=list)
    workflow: Optional[WorkflowDefinitionSchema] = None
    raw_preview_summary: Optional[str] = None
    extra_context: Dict[str, Any] = Field(default_factory=dict)
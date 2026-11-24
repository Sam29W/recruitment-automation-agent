from datetime import datetime, timezone
from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship

from app.db import Base


def utc_now():
    return datetime.now(timezone.utc)


class Candidate(Base):
    __tablename__ = "candidates"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(120), nullable=False)
    email = Column(String(120), nullable=False)
    phone = Column(String(40), nullable=True)
    role = Column(String(120), nullable=False)
    resume_score = Column(Float, nullable=True)  # Nullable to test missing-data edge cases
    prescreen_passed = Column(Boolean, nullable=True)
    interested = Column(Boolean, nullable=True)
    notice_period_days = Column(Integer, nullable=True)
    phone_interview_score = Column(Float, nullable=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    step_states = relationship("CandidateStepState", back_populates="candidate")


class WorkflowDefinition(Base):
    __tablename__ = "workflow_definitions"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(160), nullable=False)
    raw_instruction = Column(Text, nullable=False)
    clarifications_json = Column(Text, nullable=True)
    workflow_json = Column(Text, nullable=False)
    is_confirmed = Column(Boolean, default=False, nullable=False)
    confirmed_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    runs = relationship("WorkflowRun", back_populates="workflow")


class WorkflowRun(Base):
    __tablename__ = "workflow_runs"

    id = Column(Integer, primary_key=True, index=True)
    workflow_id = Column(Integer, ForeignKey("workflow_definitions.id"), nullable=False)
    status = Column(String(32), default="RUNNING", nullable=False)  # RUNNING | PAUSED | CANCELLED | COMPLETED | FAILED
    total_candidates = Column(Integer, default=0, nullable=False)
    completed_candidates = Column(Integer, default=0, nullable=False)
    started_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)
    completed_at = Column(DateTime(timezone=True), nullable=True)

    workflow = relationship("WorkflowDefinition", back_populates="runs")
    step_states = relationship("CandidateStepState", back_populates="run")
    audit_logs = relationship("AuditLog", back_populates="run")


class CandidateStepState(Base):
    __tablename__ = "candidate_step_states"

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, ForeignKey("workflow_runs.id"), nullable=False)
    candidate_id = Column(Integer, ForeignKey("candidates.id"), nullable=False)
    current_step = Column(String(64), nullable=True)
    status = Column(String(32), default="PENDING", nullable=False)  # PENDING | IN_PROGRESS | COMPLETED | SKIPPED | FAILED | CANCELLED
    outcome = Column(Text, nullable=True)
    next_action = Column(String(160), nullable=True)
    error_message = Column(Text, nullable=True)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)

    run = relationship("WorkflowRun", back_populates="step_states")
    candidate = relationship("Candidate", back_populates="step_states")


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, ForeignKey("workflow_runs.id"), nullable=True)
    workflow_id = Column(Integer, ForeignKey("workflow_definitions.id"), nullable=True)
    candidate_id = Column(Integer, nullable=True)
    event_type = Column(String(80), nullable=False)  # INSTRUCTION_RECEIVED | WORKFLOW_PARSED | WORKFLOW_CONFIRMED | ACTION_ATTEMPTED | ACTION_COMPLETED | ACTION_FAILED | RUN_PAUSED | RUN_CANCELLED | RUN_COMPLETED
    actor = Column(String(80), default="system", nullable=False)
    details_json = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    run = relationship("WorkflowRun", back_populates="audit_logs")
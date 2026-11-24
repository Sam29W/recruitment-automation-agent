import json
import os
from typing import List, Optional

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import Base, SessionLocal, engine, get_db
from app.engine import WorkflowEngine
from app.models import AuditLog, Candidate, CandidateStepState, WorkflowDefinition, WorkflowRun
from app.schemas import WorkflowDefinitionSchema
from app.seed import seed_candidates
from app.nlp_parser import parse_recruiter_instruction

app = FastAPI(title="NLP Recruitment Automation Agent API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        seed_candidates(db)
    finally:
        db.close()


class CreateWorkflowRequest(BaseModel):
    raw_instruction: str
    workflow: WorkflowDefinitionSchema
    clarifications: Optional[dict] = None


class ExecuteWorkflowRequest(BaseModel):
    candidate_ids: Optional[List[int]] = None
    simulate_failure: bool = False


class ControlRunRequest(BaseModel):
    action: str  # pause | resume | cancel


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.get("/candidates")
def list_candidates(db: Session = Depends(get_db)):
    rows = db.query(Candidate).order_by(Candidate.id.asc()).all()
    return [
        {
            "id": c.id,
            "name": c.name,
            "email": c.email,
            "phone": c.phone,
            "role": c.role,
            "resume_score": c.resume_score,
            "prescreen_passed": c.prescreen_passed,
            "interested": c.interested,
            "notice_period_days": c.notice_period_days,
            "phone_interview_score": c.phone_interview_score,
            "notes": c.notes,
        }
        for c in rows
    ]

class ParseInstructionRequest(BaseModel):
    instruction: str
    clarifications: Optional[dict] = None


@app.post("/workflows/parse")
def parse_workflow_endpoint(payload: ParseInstructionRequest, db: Session = Depends(get_db)):
    parsed = parse_recruiter_instruction(payload.instruction, payload.clarifications)
    engine_service = WorkflowEngine(db)
    engine_service.log_audit(
        event_type="INSTRUCTION_PARSED",
        details={
            "instruction": payload.instruction,
            "status": parsed.status,
            "clarification_question": parsed.clarification_question,
        },
        actor="recruiter",
    )
    return parsed.model_dump()

@app.post("/workflows")
def create_workflow(payload: CreateWorkflowRequest, db: Session = Depends(get_db)):
    wf_record = WorkflowDefinition(
        name=payload.workflow.workflow_name,
        raw_instruction=payload.raw_instruction,
        clarifications_json=json.dumps(payload.clarifications or {}),
        workflow_json=payload.workflow.model_dump_json(),
        is_confirmed=False,
    )
    db.add(wf_record)
    db.commit()
    db.refresh(wf_record)

    engine_service = WorkflowEngine(db)
    engine_service.log_audit(
        event_type="WORKFLOW_CREATED",
        details={"workflow_id": wf_record.id, "workflow_name": wf_record.name},
        workflow_id=wf_record.id,
        actor="recruiter",
    )
    return {
        "id": wf_record.id,
        "name": wf_record.name,
        "is_confirmed": wf_record.is_confirmed,
        "workflow": payload.workflow.model_dump(),
    }


@app.post("/workflows/{workflow_id}/confirm")
def confirm_workflow(workflow_id: int, db: Session = Depends(get_db)):
    wf = db.query(WorkflowDefinition).filter(WorkflowDefinition.id == workflow_id).first()
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")

    from datetime import datetime, timezone

    wf.is_confirmed = True
    wf.confirmed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(wf)

    engine_service = WorkflowEngine(db)
    engine_service.log_audit(
        event_type="WORKFLOW_CONFIRMED",
        details={"workflow_id": wf.id, "confirmed_at": wf.confirmed_at.isoformat()},
        workflow_id=wf.id,
        actor="recruiter",
    )
    return {"id": wf.id, "is_confirmed": wf.is_confirmed, "confirmed_at": wf.confirmed_at}


@app.post("/workflows/{workflow_id}/execute")
def execute_workflow(
    workflow_id: int,
    payload: ExecuteWorkflowRequest,
    db: Session = Depends(get_db),
):
    wf = db.query(WorkflowDefinition).filter(WorkflowDefinition.id == workflow_id).first()
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")

    sim_fail = payload.simulate_failure or (
        os.getenv("SIMULATE_INTEGRATION_FAILURE", "false").lower() == "true"
    )
    runner = WorkflowEngine(db, simulate_failure=sim_fail)
    try:
        run = runner.start_run(wf, candidate_ids=payload.candidate_ids)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return {"run_id": run.id, "status": run.status, "total_candidates": run.total_candidates}


@app.post("/runs/{run_id}/control")
def control_run(run_id: int, payload: ControlRunRequest, db: Session = Depends(get_db)):
    runner = WorkflowEngine(db)
    try:
        run = runner.control_run(run_id, payload.action)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"run_id": run.id, "status": run.status, "completed_candidates": run.completed_candidates}


@app.get("/runs/{run_id}")
def get_run_monitor(run_id: int, db: Session = Depends(get_db)):
    run = db.query(WorkflowRun).filter(WorkflowRun.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    states = (
        db.query(CandidateStepState, Candidate)
        .join(Candidate, CandidateStepState.candidate_id == Candidate.id)
        .filter(CandidateStepState.run_id == run_id)
        .order_by(Candidate.id.asc())
        .all()
    )
    return {
        "run_id": run.id,
        "workflow_id": run.workflow_id,
        "status": run.status,
        "total_candidates": run.total_candidates,
        "completed_candidates": run.completed_candidates,
        "candidates": [
            {
                "candidate_id": cand.id,
                "name": cand.name,
                "current_step": st.current_step,
                "status": st.status,
                "outcome": st.outcome,
                "next_action": st.next_action,
                "error_message": st.error_message,
            }
            for st, cand in states
        ],
    }


@app.get("/audit-logs")
def list_audit_logs(run_id: Optional[int] = None, db: Session = Depends(get_db)):
    q = db.query(AuditLog)
    if run_id is not None:
        q = q.filter(AuditLog.run_id == run_id)
    logs = q.order_by(AuditLog.id.asc()).all()
    return [
        {
            "id": log.id,
            "run_id": log.run_id,
            "workflow_id": log.workflow_id,
            "candidate_id": log.candidate_id,
            "event_type": log.event_type,
            "actor": log.actor,
            "details": json.loads(log.details_json),
            "created_at": log.created_at.isoformat(),
        }
        for log in logs
    ]
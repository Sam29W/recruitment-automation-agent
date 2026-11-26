import json
import os
import re
from typing import List, Optional

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from app.db import Base, SessionLocal, engine, get_db
from app.engine import WorkflowEngine
from app.models import AuditLog, Candidate, CandidateStepState, WorkflowDefinition, WorkflowRun
from app.nlp_parser import parse_recruiter_instruction
from app.schemas import WorkflowDefinitionSchema
from app.seed import seed_candidates

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


class ParseInstructionRequest(BaseModel):
    instruction: str
    clarifications: Optional[dict] = None


class CreateCandidateRequest(BaseModel):
    name: str
    email: EmailStr | str
    phone: str | None = None
    role: str = "Software Engineer"
    resume_score: float | None = 80.0
    prescreen_passed: bool | None = None
    interested: bool | None = True
    notice_period_days: int | None = 15
    phone_interview_score: float | None = None
    notes: str | None = "Added live via Recruiter Studio"


class ResumeItemInput(BaseModel):
    filename: Optional[str] = None
    content: str


class IngestResumesRequest(BaseModel):
    resumes: List[ResumeItemInput]
    target_role: Optional[str] = "Software Engineer"


def _split_multi_resumes(raw_text: str) -> List[str]:
    parts = re.split(
        r"\n\s*(?:---|===|\*\*\*|RESUME\s*#\d+|CANDIDATE\s*#\d+)\s*\n",
        raw_text.strip(),
        flags=re.IGNORECASE,
    )
    cleaned = [p.strip() for p in parts if p and len(p.strip()) > 15]
    return cleaned if cleaned else ([raw_text.strip()] if raw_text.strip() else [])


def _heuristic_parse_resume(text: str, filename: Optional[str], fallback_role: str) -> dict:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    first_line = lines[0] if lines else "Candidate"
    name = re.sub(r"^(?:name|candidate)\s*:\s*", "", first_line, flags=re.IGNORECASE).strip()
    if len(name) > 60 or "@" in name:
        name = (
            (filename or "Candidate")
            .rsplit(".", 1)[0]
            .replace("_", " ")
            .replace("-", " ")
            .title()
        )

    email_match = re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", text)
    email = (
        email_match.group(0)
        if email_match
        else f"{re.sub(r'[^a-z0-9]+', '.', name.lower()).strip('.')}@applicant.local"
    )

    phone_match = re.search(r"(?:\+?\d[\d\s\-()]{8,}\d)", text)
    phone = phone_match.group(0).strip() if phone_match else None

    notice_match = re.search(
        r"notice(?:\s*period)?\s*[:\-]?\s*(\d+)\s*(?:days?|d)?", text, flags=re.IGNORECASE
    )
    notice_days = int(notice_match.group(1)) if notice_match else 30

    lower = text.lower()
    role = fallback_role
    for candidate_role in [
        "AI/ML Engineer",
        "Machine Learning Engineer",
        "Backend Engineer",
        "Frontend Engineer",
        "Full Stack Engineer",
        "Data Scientist",
        "Software Engineer",
    ]:
        if candidate_role.lower() in lower:
            role = candidate_role
            break

    score = 52
    skill_tokens = [
        "python",
        "pytorch",
        "fastapi",
        "react",
        "typescript",
        "sql",
        "postgresql",
        "docker",
        "aws",
        "machine learning",
        "llm",
        "nlp",
        "api",
        "git",
        "kubernetes",
    ]
    hits = sum(1 for tok in skill_tokens if tok in lower)
    score += min(32, hits * 4)
    if re.search(r"\b\d+\+?\s*(?:years?|yrs?)\b", lower):
        score += 8
    if "github" in lower or "project" in lower:
        score += 4
    ats_score = max(15, min(98, score))

    interested = False if ("not interested" in lower or "declined" in lower) else True
    summary = " | ".join(lines[1:4])[:220] if len(lines) > 1 else text[:220]

    return {
        "name": name[:120],
        "email": email[:160],
        "phone": phone[:40] if phone else None,
        "role": role[:120],
        "resume_score": float(ats_score),
        "notice_period_days": notice_days,
        "interested": interested,
        "notes": f"ATS Score: {ats_score}/100. {summary}".strip(),
    }


def _ai_analyze_resume(text: str, filename: Optional[str], fallback_role: str) -> dict:
    api_key = os.getenv("LLM_API_KEY") or os.getenv("GEMINI_API_KEY")
    if api_key and not api_key.startswith("your_"):
        try:
            from google import genai
            from google.genai import types

            client = genai.Client(api_key=api_key)
            prompt = f"""
Extract candidate fields and calculate an objective ATS Resume Score (0-100) for target role '{fallback_role}'.
Return strictly valid JSON with keys:
name (string), email (string), phone (string or null), role (string),
resume_score (number 0-100), notice_period_days (integer or null),
interested (boolean), notes (concise string summarizing ATS evaluation and top skills).

Resume text:
{text[:4500]}
"""
            resp = client.models.generate_content(
                model=os.getenv("LLM_MODEL", "gemini-2.5-flash"),
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    temperature=0.1,
                ),
            )
            if resp.text:
                parsed = json.loads(resp.text)
                if isinstance(parsed, dict) and parsed.get("name"):
                    score_val = parsed.get("resume_score")
                    parsed["resume_score"] = (
                        max(0.0, min(100.0, float(score_val)))
                        if score_val is not None
                        else 70.0
                    )
                    parsed["email"] = (
                        parsed.get("email")
                        or _heuristic_parse_resume(text, filename, fallback_role)["email"]
                    )
                    parsed["role"] = parsed.get("role") or fallback_role
                    parsed["interested"] = bool(parsed.get("interested", True))
                    return parsed
        except Exception:
            pass

    return _heuristic_parse_resume(text, filename, fallback_role)


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


@app.post("/candidates", status_code=201)
def create_candidate(payload: CreateCandidateRequest, db: Session = Depends(get_db)):
    candidate = Candidate(
        name=payload.name.strip(),
        email=payload.email.strip(),
        phone=payload.phone.strip() if payload.phone else None,
        role=payload.role.strip() or "Software Engineer",
        resume_score=payload.resume_score,
        prescreen_passed=payload.prescreen_passed,
        interested=payload.interested,
        notice_period_days=payload.notice_period_days,
        phone_interview_score=payload.phone_interview_score,
        notes=payload.notes.strip() if payload.notes else None,
    )
    db.add(candidate)
    db.commit()
    db.refresh(candidate)
    return candidate


@app.post("/candidates/ingest-resumes", status_code=201)
def ingest_resumes(payload: IngestResumesRequest, db: Session = Depends(get_db)):
    created = []
    target_role = (payload.target_role or "Software Engineer").strip()

    for item in payload.resumes:
        chunks = _split_multi_resumes(item.content or "")
        for idx, chunk in enumerate(chunks):
            label = (
                item.filename
                if len(chunks) == 1
                else f"{item.filename or 'resume'} #{idx + 1}"
            )
            info = _ai_analyze_resume(chunk, label, target_role)
            cand = Candidate(
                name=info["name"],
                email=info["email"],
                phone=info.get("phone"),
                role=info["role"],
                resume_score=info["resume_score"],
                prescreen_passed=None,
                interested=info.get("interested", True),
                notice_period_days=info.get("notice_period_days", 30),
                phone_interview_score=None,
                notes=info.get("notes"),
            )
            db.add(cand)
            db.flush()
            created.append(cand)

    db.commit()
    for c in created:
        db.refresh(c)

    return {"added_count": len(created), "candidates": created}


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
    return {
        "run_id": run.id,
        "status": run.status,
        "completed_candidates": run.completed_candidates,
    }


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
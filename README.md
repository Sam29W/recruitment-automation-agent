# NLP-Powered Recruitment Automation Agent

A prototype chat-first recruitment automation agent that turns natural-language recruiter instructions into structured, validated hiring workflows with explicit confirmation, live monitoring, and audit logs.

## Architecture

- **Interpreter (`backend/app/nlp_parser.py` & `frontend/src/App.tsx`):** Takes recruiter instructions in chat (plus optional browser voice input), asks a clarification question if a rule/threshold/recipient is ambiguous, and produces a structured workflow.
- **Validator (`backend/app/schemas.py`):** Validates workflow steps, conditions, thresholds, actions, and step transitions in Python using Pydantic before any run starts[cite: 1, 2].
- **Execution Engine & Adapters (`backend/app/engine.py` & `backend/app/adapters/`):** Requires explicit recruiter confirmation before executing actions, steps candidates through rules, supports pause/resume/cancel, prevents duplicate actions, and logs every event to `AuditLog`[cite: 1, 2].

## How to Run Locally

### 1. Start the Backend (FastAPI + SQLite)

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
cd ..
$env:PYTHONPATH="backend"
uvicorn app.main:app --reload --port 8000
# NLP-Powered Recruitment Automation Agent

Turns natural-language recruiter instructions into validated hiring workflows with a preview, explicit confirmation button, live candidate monitor, and audit log.

## How to Run

### 1. Backend (FastAPI + SQLite)
Open a terminal in the project root and run:
```powershell
$env:PYTHONPATH="backend"
.\backend\.venv\Scripts\uvicorn.exe app.main:app --reload --port 8000
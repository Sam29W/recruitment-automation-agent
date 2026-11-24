from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

payload = {
    "raw_instruction": (
        "Select candidates whose AI Resume Score is above 70. Trigger AI prescreen phone calls. "
        "If a candidate does not pass the phone prescreen, send them a WhatsApp questionnaire. "
        "For candidates who are interested and have a notice period below 30 days, trigger an AI Phone Interview. "
        "If they score above 60 in the AI Phone Interview, send an email alert to both the recruiter and the Hiring Manager."
    ),
    "workflow": {
        "workflow_name": "Example Hiring Flow",
        "entry_step_id": "s1",
        "steps": [
            {
                "step_id": "s1",
                "step_type": "filter",
                "description": "AI Resume Score > 70",
                "condition": {"field": "resume_score", "operator": ">", "value": 70},
                "on_true": "s2",
                "on_false": "REJECT",
            },
            {
                "step_id": "s2",
                "step_type": "action",
                "description": "Trigger AI prescreen phone call",
                "action": {
                    "action_type": "ai_prescreen_call",
                    "recipients": ["candidate"],
                    "template_or_prompt": "Run initial AI prescreen call",
                },
                "next_step": "s3",
            },
            {
                "step_id": "s3",
                "step_type": "branch",
                "description": "Check if phone prescreen passed",
                "condition": {"field": "prescreen_passed", "operator": "==", "value": True},
                "on_true": "s5",
                "on_false": "s4",
            },
            {
                "step_id": "s4",
                "step_type": "action",
                "description": "Send WhatsApp questionnaire",
                "action": {
                    "action_type": "whatsapp_questionnaire",
                    "recipients": ["candidate"],
                    "template_or_prompt": "Are you interested and what is your notice period?",
                },
                "next_step": "s5",
            },
            {
                "step_id": "s5",
                "step_type": "branch",
                "description": "Interested AND notice period < 30 days",
                "condition": {
                    "field": "interested",
                    "operator": "==",
                    "value": True,
                    "combine_with": "AND",
                    "next_condition": {
                        "field": "notice_period_days",
                        "operator": "<",
                        "value": 30,
                    },
                },
                "on_true": "s6",
                "on_false": "END",
            },
            {
                "step_id": "s6",
                "step_type": "action",
                "description": "Trigger AI Phone Interview",
                "action": {
                    "action_type": "ai_phone_interview",
                    "recipients": ["candidate"],
                    "template_or_prompt": "Conduct technical AI phone interview",
                },
                "next_step": "s7",
            },
            {
                "step_id": "s7",
                "step_type": "branch",
                "description": "AI Phone Interview Score > 60",
                "condition": {
                    "field": "phone_interview_score",
                    "operator": ">",
                    "value": 60,
                },
                "on_true": "s8",
                "on_false": "END",
            },
            {
                "step_id": "s8",
                "step_type": "action",
                "description": "Email recruiter and Hiring Manager",
                "action": {
                    "action_type": "email_alert",
                    "recipients": ["recruiter", "hiring_manager"],
                    "template_or_prompt": "Candidate passed AI Phone Interview > 60",
                },
                "next_step": "END",
            },
        ],
    },
}

res_create = client.post("/workflows", json=payload)
assert res_create.status_code == 200, res_create.text
wf_id = res_create.json()["id"]

res_confirm = client.post(f"/workflows/{wf_id}/confirm")
assert res_confirm.status_code == 200, res_confirm.text

res_exec = client.post(f"/workflows/{wf_id}/execute", json={})
assert res_exec.status_code == 200, res_exec.text
run_id = res_exec.json()["run_id"]

monitor = client.get(f"/runs/{run_id}").json()
print("Run Status:", monitor["status"])
for cand in monitor["candidates"]:
    print(f"- {cand['name']}: {cand['status']} | {cand['outcome']}")

logs = client.get(f"/audit-logs?run_id={run_id}").json()
print("Audit Log Count:", len(logs))
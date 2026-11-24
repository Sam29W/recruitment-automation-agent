from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import app
from app.nlp_parser import parse_recruiter_instruction
from app.schemas import WorkflowDefinitionSchema

client = TestClient(app)


def test_multi_prompt_parsing():
    prompts = [
        # 1. Main example prompt
        (
            "Select candidates whose AI Resume Score is above 70. Trigger AI prescreen phone calls. "
            "If a candidate does not pass the phone prescreen, send them a WhatsApp questionnaire to check "
            "their interest and ask basic HR questions. For candidates who are interested and have a notice "
            "period below 30 days, trigger an AI Phone Interview. If they score above 60 in the AI Phone "
            "Interview, send an email alert to both the recruiter and the Hiring Manager."
        ),
        # 2. Additional instruction #1: WhatsApp + notice period + recruiter email
        (
            "Filter candidates with AI Resume Score above 75 and notice period under 30 days, send a "
            "WhatsApp questionnaire, and email the recruiter."
        ),
        # 3. Additional instruction #2: Phone interview + Hiring Manager email
        (
            "For candidates with AI Resume Score above 80, trigger an AI Phone Interview and if their "
            "score is above 60, send an email alert to the Hiring Manager."
        ),
    ]

    for idx, prompt in enumerate(prompts, start=1):
        res = client.post("/workflows/parse", json={"instruction": prompt})
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["status"] == "workflow_ready", f"Prompt {idx} failed to parse: {data}"
        assert len(data["workflow"]["steps"]) >= 2
        print(f"[PASS] Prompt {idx} parsed -> {data['workflow']['workflow_name']} ({len(data['workflow']['steps'])} steps)")


def test_clarification_flow():
    ambiguous = parse_recruiter_instruction("Send an email alert if candidates have a high score")
    assert ambiguous.status == "clarification_needed"
    assert ambiguous.clarification_question is not None

    resolved = parse_recruiter_instruction(
        "Send an email alert to the recruiter if candidates have a high score",
        clarifications={"clarification_answer": "resume score above 80"},
    )
    assert resolved.status == "workflow_ready"
    print("[PASS] Clarification prompt & follow-up resolution")


def test_edge_cases_and_controls():
    # Invalid threshold (> 100) must fail validation
    try:
        WorkflowDefinitionSchema(
            workflow_name="Invalid Score Flow",
            entry_step_id="s1",
            steps=[
                {
                    "step_id": "s1",
                    "step_type": "filter",
                    "description": "Invalid score",
                    "condition": {"field": "resume_score", "operator": ">", "value": 150},
                    "on_true": "END",
                    "on_false": "REJECT",
                }
            ],
        )
        raise AssertionError("Expected ValidationError for resume_score > 150")
    except ValidationError:
        print("[PASS] Invalid threshold rejected by schema")

    # Create workflow and verify execution is blocked until confirmed
    parsed = client.post(
        "/workflows/parse",
        json={
            "instruction": "For candidates with AI Resume Score above 80, trigger an AI Phone Interview and email the Hiring Manager."
        },
    ).json()
    wf_id = client.post(
        "/workflows",
        json={"raw_instruction": "Fast-track flow", "workflow": parsed["workflow"]},
    ).json()["id"]

    blocked = client.post(f"/workflows/{wf_id}/execute", json={})
    assert blocked.status_code == 400
    print("[PASS] Unconfirmed workflow execution blocked")

    # Confirm and execute with simulated failure enabled on a second run
    client.post(f"/workflows/{wf_id}/confirm")
    ok_run = client.post(f"/workflows/{wf_id}/execute", json={"simulate_failure": False}).json()
    assert ok_run["status"] == "COMPLETED"

    fail_run = client.post(f"/workflows/{wf_id}/execute", json={"simulate_failure": True}).json()
    fail_mon = client.get(f"/runs/{fail_run['run_id']}").json()
    assert any(c["status"] == "FAILED" or c["error_message"] for c in fail_mon["candidates"])
    print("[PASS] Simulated integration failure captured cleanly")

    # Pause & cancel test
    pause_run = client.post(f"/workflows/{wf_id}/execute", json={}).json()
    paused = client.post(f"/runs/{pause_run['run_id']}/control", json={"action": "pause"}).json()
    assert paused["status"] == "PAUSED"
    cancelled = client.post(f"/runs/{pause_run['run_id']}/control", json={"action": "cancel"}).json()
    assert cancelled["status"] == "CANCELLED"
    print("[PASS] Pause and cancel run controls verified")


if __name__ == "__main__":
    test_multi_prompt_parsing()
    test_clarification_flow()
    test_edge_cases_and_controls()
    print("ALL STEP 3.2 SCENARIO TESTS PASSED!")
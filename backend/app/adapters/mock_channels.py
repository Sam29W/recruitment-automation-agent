from typing import Any, Dict, Optional

from app.adapters.base import AdapterResult, BaseChannelAdapter


class MockTelephonyAdapter(BaseChannelAdapter):
    channel_name = "telephony"

    def __init__(self, mode: str = "prescreen"):
        self.mode = mode  # "prescreen" or "phone_interview"

    def send(
        self,
        recipient: str,
        message: str,
        context: Optional[Dict[str, Any]] = None,
        force_fail: bool = False,
    ) -> AdapterResult:
        ctx = context or {}
        if not recipient or not recipient.strip():
            return AdapterResult(
                success=False,
                channel=self.channel_name,
                simulated=True,
                recipient=recipient or "",
                summary=f"[SIMULATED] {self.mode} call skipped due to missing phone number",
                error="Missing recipient phone number",
            )

        if force_fail:
            return AdapterResult(
                success=False,
                channel=self.channel_name,
                simulated=True,
                recipient=recipient,
                summary=f"[SIMULATED] {self.mode} call failed for {recipient}",
                error="Simulated telephony provider timeout",
            )

        if self.mode == "prescreen":
            passed = ctx.get("prescreen_passed")
            if passed is None:
                resume_score = ctx.get("resume_score")
                passed = bool(resume_score is not None and float(resume_score) >= 75)
            outcome_label = "PASSED" if passed else "DID_NOT_PASS"
            return AdapterResult(
                success=True,
                channel=self.channel_name,
                simulated=True,
                recipient=recipient,
                summary=f"[SIMULATED] AI prescreen call to {recipient} completed -> {outcome_label}",
                metadata={"mode": self.mode, "prescreen_passed": passed, "prompt": message},
            )

        score = ctx.get("phone_interview_score")
        if score is None:
            score = 72.0 if ctx.get("interested") else 45.0
        passed_interview = float(score) > 60
        return AdapterResult(
            success=True,
            channel=self.channel_name,
            simulated=True,
            recipient=recipient,
            summary=f"[SIMULATED] AI phone interview with {recipient} completed (score: {score}, pass>60: {passed_interview})",
            metadata={"mode": self.mode, "phone_interview_score": float(score), "passed": passed_interview},
        )


class MockWhatsAppAdapter(BaseChannelAdapter):
    channel_name = "whatsapp"

    def send(
        self,
        recipient: str,
        message: str,
        context: Optional[Dict[str, Any]] = None,
        force_fail: bool = False,
    ) -> AdapterResult:
        ctx = context or {}
        if not recipient or not recipient.strip():
            return AdapterResult(
                success=False,
                channel=self.channel_name,
                simulated=True,
                recipient=recipient or "",
                summary="[SIMULATED] WhatsApp questionnaire skipped due to missing phone number",
                error="Missing WhatsApp recipient number",
            )

        if force_fail:
            return AdapterResult(
                success=False,
                channel=self.channel_name,
                simulated=True,
                recipient=recipient,
                summary=f"[SIMULATED] WhatsApp message failed to deliver to {recipient}",
                error="Simulated WhatsApp webhook delivery error",
            )

        interested = ctx.get("interested")
        notice_days = ctx.get("notice_period_days")
        return AdapterResult(
            success=True,
            channel=self.channel_name,
            simulated=True,
            recipient=recipient,
            summary=(
                f"[SIMULATED] WhatsApp questionnaire sent to {recipient} "
                f"(recorded interested={interested}, notice_period_days={notice_days})"
            ),
            metadata={
                "interested": interested,
                "notice_period_days": notice_days,
                "questionnaire": message,
            },
        )


class MockEmailAdapter(BaseChannelAdapter):
    channel_name = "email"

    def send(
        self,
        recipient: str,
        message: str,
        context: Optional[Dict[str, Any]] = None,
        force_fail: bool = False,
    ) -> AdapterResult:
        ctx = context or {}
        if not recipient or not recipient.strip():
            return AdapterResult(
                success=False,
                channel=self.channel_name,
                simulated=True,
                recipient=recipient or "",
                summary="[SIMULATED] Email alert skipped due to missing recipient",
                error="Missing email recipient",
            )

        if force_fail:
            return AdapterResult(
                success=False,
                channel=self.channel_name,
                simulated=True,
                recipient=recipient,
                summary=f"[SIMULATED] Email alert failed to send to {recipient}",
                error="Simulated SMTP relay failure",
            )

        candidate_name = ctx.get("candidate_name", "Candidate")
        return AdapterResult(
            success=True,
            channel=self.channel_name,
            simulated=True,
            recipient=recipient,
            summary=f"[SIMULATED] Email alert sent to {recipient} regarding {candidate_name}",
            metadata={"candidate_name": candidate_name, "body": message},
        )
from sqlalchemy.orm import Session
from app.models import Candidate


SAMPLE_CANDIDATES = [
    {
        "name": "Ananya Rao",
        "email": "ananya.rao@example.com",
        "phone": "+91-9845011223",
        "role": "AI/ML Engineer",
        "resume_score": 88.0,
        "prescreen_passed": True,
        "interested": True,
        "notice_period_days": 15,
        "phone_interview_score": 79.0,
        "notes": "Strong full-path candidate: passes resume score > 70, passes prescreen, phone interview > 60.",
    },
    {
        "name": "Rohan Kulkarni",
        "email": "rohan.kulkarni@example.com",
        "phone": "+91-9845022334",
        "role": "Backend Python Engineer",
        "resume_score": 76.0,
        "prescreen_passed": False,
        "interested": True,
        "notice_period_days": 20,
        "phone_interview_score": 68.0,
        "notes": "Fails phone prescreen -> gets WhatsApp check-in -> interested & notice < 30d -> phone interview > 60.",
    },
    {
        "name": "Meera Nair",
        "email": "meera.nair@example.com",
        "phone": "+91-9845033445",
        "role": "Full Stack Engineer",
        "resume_score": 81.0,
        "prescreen_passed": False,
        "interested": True,
        "notice_period_days": 60,
        "phone_interview_score": None,
        "notes": "Fails prescreen -> WhatsApp check-in -> interested, but notice period >= 30 days (filtered before phone interview).",
    },
    {
        "name": "Karthik Menon",
        "email": "karthik.menon@example.com",
        "phone": "+91-9845044556",
        "role": "ML Platform Engineer",
        "resume_score": 74.0,
        "prescreen_passed": False,
        "interested": False,
        "notice_period_days": 15,
        "phone_interview_score": None,
        "notes": "Fails prescreen -> WhatsApp check-in -> not interested.",
    },
    {
        "name": "Vikram Deshmukh",
        "email": "vikram.deshmukh@example.com",
        "phone": "+91-9845055667",
        "role": "Data Engineer",
        "resume_score": 54.0,
        "prescreen_passed": None,
        "interested": None,
        "notice_period_days": 30,
        "phone_interview_score": None,
        "notes": "Filtered out at initial resume score check (<= 70).",
    },
    {
        "name": "Divya Sharma",
        "email": "divya.sharma@example.com",
        "phone": None,
        "role": "AI Engineer",
        "resume_score": None,
        "prescreen_passed": None,
        "interested": True,
        "notice_period_days": 15,
        "phone_interview_score": 72.0,
        "notes": "Edge case: missing resume_score and phone number.",
    },
]


def seed_candidates(db: Session) -> int:
    existing_emails = {row.email for row in db.query(Candidate.email).all()}
    added = 0
    for item in SAMPLE_CANDIDATES:
        if item["email"] not in existing_emails:
            db.add(Candidate(**item))
            added += 1
    if added > 0:
        db.commit()
    return added
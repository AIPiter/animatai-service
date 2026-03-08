import resend
from .config import settings


async def send_verification_email(email: str, code: str):
    if not settings.resend_api_key:
        print(f"[email] RESEND_API_KEY not set — skipping. Code for {email}: {code}")
        return

    resend.api_key = settings.resend_api_key
    resend.Emails.send({
        "from":    settings.from_email,
        "to":      [email],
        "subject": "Your AnimatAI verification code",
        "html":    f"<p>Your verification code: <strong>{code}</strong></p><p>Valid for 10 minutes.</p>",
    })

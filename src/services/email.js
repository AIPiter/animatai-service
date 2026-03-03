import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendVerificationEmail(email, code) {
  const { data, error } = await resend.emails.send({
    from: process.env.FROM_EMAIL || 'AnimatAI <noreply@animatai.io>',
    to: email,
    subject: `${code} — ваш код подтверждения AnimatAI`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:40px 32px;background:#0f0f0f;color:#ffffff;border-radius:16px;">
        <div style="font-size:22px;font-weight:700;margin-bottom:6px;letter-spacing:-0.02em;">AnimatAI</div>
        <div style="font-size:13px;color:#666;margin-bottom:36px;">Подтверждение email</div>

        <p style="font-size:15px;color:#d0d0d0;margin-bottom:28px;line-height:1.6;">
          Введите код ниже для завершения регистрации:
        </p>

        <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:14px;padding:32px;text-align:center;margin-bottom:28px;">
          <div style="font-size:48px;font-weight:700;letter-spacing:16px;font-family:'Courier New',monospace;color:#ffffff;">${code}</div>
        </div>

        <p style="font-size:13px;color:#555;line-height:1.7;">
          Код действителен <strong style="color:#888;">10 минут</strong>.<br>
          Если вы не регистрировались на AnimatAI — просто проигнорируйте это письмо.
        </p>
      </div>
    `,
  });
  if (error) throw new Error(error.message);
}

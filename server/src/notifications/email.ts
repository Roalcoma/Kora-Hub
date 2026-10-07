// Emails transaccionales por SMTP (Mailpit en local; Brevo/Resend en producción).
import nodemailer, { type Transporter } from 'nodemailer';

let transport: Transporter | null = null;
const mailer = () => (transport ??= nodemailer.createTransport(process.env.SMTP_URL ?? 'smtp://localhost:51025'));

type Email = { to: string; template: 'invitation' | 'password_reset'; url: string; locale?: 'es' | 'en' };

const TEMPLATES = {
  es: {
    invitation: { subject: 'Te invitaron a Kora', text: (url: string) => `Te invitaron a unirte al espacio de trabajo de tu agencia en Kora.\n\nAcepta la invitación aquí:\n${url}\n\nEl enlace vence en 7 días.` },
    password_reset: { subject: 'Recupera tu contraseña', text: (url: string) => `Pediste crear una nueva contraseña.\n\nHazlo aquí (el enlace vence en 1 hora):\n${url}\n\nSi no lo pediste, ignora este correo.` },
  },
  en: {
    invitation: { subject: "You're invited to Kora", text: (url: string) => `You've been invited to join your agency's workspace on Kora.\n\nAccept here:\n${url}\n\nThe link expires in 7 days.` },
    password_reset: { subject: 'Reset your password', text: (url: string) => `You asked to set a new password.\n\nDo it here (the link expires in 1 hour):\n${url}\n\nIf you didn't ask, ignore this email.` },
  },
};

export async function sendEmail(e: Email) {
  const t = TEMPLATES[e.locale ?? 'es'][e.template];
  await mailer().sendMail({ from: process.env.MAIL_FROM ?? 'Kora <no-reply@kora.local>', to: e.to, subject: t.subject, text: t.text(e.url) });
}

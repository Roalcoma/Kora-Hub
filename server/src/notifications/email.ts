// Emails transaccionales por SMTP (Mailpit en local; Brevo/Resend en producción).
import nodemailer, { type Transporter } from 'nodemailer';

let transport: Transporter | null = null;
const mailer = () => (transport ??= nodemailer.createTransport(process.env.SMTP_URL ?? 'smtp://localhost:51025'));

type Email = {
  to: string; template: 'invitation' | 'password_reset' | 'trial_ending' | 'grace_ending'; url: string; locale?: 'es' | 'en';
  days?: number; workspaceName?: string;   // avisos de facturación
};

const dias = (n = 1) => (n === 1 ? '1 día' : `${n} días`);
const days = (n = 1) => (n === 1 ? '1 day' : `${n} days`);

const TEMPLATES: Record<'es' | 'en', Record<Email['template'], { subject: (e: Email) => string; text: (e: Email) => string }>> = {
  es: {
    invitation: { subject: () => 'Te invitaron a Kora', text: (e) => `Te invitaron a unirte al espacio de trabajo de tu agencia en Kora.\n\nAcepta la invitación aquí:\n${e.url}\n\nEl enlace vence en 7 días.` },
    password_reset: { subject: () => 'Recupera tu contraseña', text: (e) => `Pediste crear una nueva contraseña.\n\nHazlo aquí (el enlace vence en 1 hora):\n${e.url}\n\nSi no lo pediste, ignora este correo.` },
    trial_ending: {
      subject: (e) => `Tu prueba de Kora vence en ${dias(e.days)}`,
      text: (e) => `La prueba gratis de ${e.workspaceName} vence en ${dias(e.days)}. Después el espacio queda en solo lectura: nadie pierde datos, pero no se podrá escribir.\n\nElige un plan aquí:\n${e.url}`,
    },
    grace_ending: {
      subject: (e) => `Falta el pago de Kora: quedan ${dias(e.days)}`,
      text: (e) => `No pudimos cobrar la suscripción de ${e.workspaceName}. En ${dias(e.days)} el espacio queda en solo lectura.\n\nActualiza el método de pago aquí:\n${e.url}`,
    },
  },
  en: {
    invitation: { subject: () => "You're invited to Kora", text: (e) => `You've been invited to join your agency's workspace on Kora.\n\nAccept here:\n${e.url}\n\nThe link expires in 7 days.` },
    password_reset: { subject: () => 'Reset your password', text: (e) => `You asked to set a new password.\n\nDo it here (the link expires in 1 hour):\n${e.url}\n\nIf you didn't ask, ignore this email.` },
    trial_ending: {
      subject: (e) => `Your Kora trial ends in ${days(e.days)}`,
      text: (e) => `The free trial of ${e.workspaceName} ends in ${days(e.days)}. After that the workspace becomes read-only: no data is lost, but nobody can write.\n\nChoose a plan here:\n${e.url}`,
    },
    grace_ending: {
      subject: (e) => `Kora payment pending: ${days(e.days)} left`,
      text: (e) => `We couldn't charge the subscription of ${e.workspaceName}. In ${days(e.days)} the workspace becomes read-only.\n\nUpdate your payment method here:\n${e.url}`,
    },
  },
};

export async function sendEmail(e: Email) {
  const t = TEMPLATES[e.locale ?? 'es'][e.template];
  await mailer().sendMail({ from: process.env.MAIL_FROM ?? 'Kora <no-reply@kora.local>', to: e.to, subject: t.subject(e), text: t.text(e) });
}

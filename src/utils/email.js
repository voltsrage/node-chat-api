import nodemailer from 'nodemailer';
import { logger } from './logger.js';

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

export async function sendVerificationEmail(to, token) {
  const link = `${process.env.APP_URL}/api/v1/auth/verify-email?token=${token}`;

  await transporter.sendMail({
    from: `"TeamChat" <${process.env.SMTP_FROM}>`,
    to,
    subject: 'Verify your TeamChat email address',
    text: `Verify your email by visiting: ${link}\n\nThis link expires in 24 hours.`,
    html: `
      <p>Thanks for registering. Click the link below to verify your email address:</p>
      <p><a href="${link}">${link}</a></p>
      <p>This link expires in 24 hours. If you did not register, ignore this email.</p>
    `,
  });

  logger.info({ to }, 'Verification email sent');
}

export async function sendPasswordResetEmail(to, token) {
  const link = `${process.env.APP_URL}/api/v1/auth/reset-password?token=${token}`;

  await transporter.sendMail({
    from: `"TeamChat" <${process.env.SMTP_FROM}>`,
    to,
    subject: 'Reset your TeamChat password',
    text: `Reset your password by visiting: ${link}\n\nThis link expires in 1 hour. If you did not request this, ignore the email.`,
    html: `
      <p>You requested a password reset. Click the link below:</p>
      <p><a href="${link}">${link}</a></p>
      <p>This link expires in 1 hour. If you did not request this, your account is safe — ignore this email.</p>
    `,
  });

  logger.info({ to }, 'Password reset email sent');
}
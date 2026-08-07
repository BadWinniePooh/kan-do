import nodemailer from 'nodemailer';
import { config } from '../config.js';

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
  enabled: boolean;
}

export function createSmtpMailer(): Mailer {
  if (!config.smtp.enabled) {
    return { enabled: false, send: async () => {} };
  }
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return {
    enabled: true,
    async send(to, subject, text) {
      await transport.sendMail({ from: config.smtp.from, to, subject, text });
    },
  };
}

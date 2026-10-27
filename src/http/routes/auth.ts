import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { registerSchema } from '../../modules/auth/service';
import { profileUpdateSchema } from '../../modules/users/service';
import { emailSchema, parse, passwordSchema } from '../../shared/validation';
import type { Guards } from '../app';

const loginSchema = z.strictObject({ email: emailSchema, password: z.string().min(1).max(128) });
const mfaVerifySchema = z.strictObject({ mfaToken: z.string().min(10).max(2048), code: z.string().regex(/^\d{6}$/).optional(), recoveryCode: z.string().min(8).max(32).optional() })
  .refine((v) => !!v.code !== !!v.recoveryCode, { message: 'Provide exactly one of code or recoveryCode' });
const refreshSchema = z.strictObject({ refreshToken: z.string().min(20).max(200) });
const activateSchema = z.strictObject({ code: z.string().regex(/^\d{6}$/) });
const passwordChangeSchema = z.strictObject({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema });

export async function authRoutes(app: FastifyInstance, c: Container, g: Guards) {
  const authLimit = g.limit('auth', c.cfg.rateLimit.authPerMin);
  const meta = (req: { ip: string; headers: Record<string, unknown> }) => ({ ip: req.ip, userAgent: req.headers['user-agent'] as string | undefined });

  app.post('/auth/register', { preHandler: authLimit }, async (req, reply) => {
    const out = await c.auth.register(parse(registerSchema, req.body));
    reply.status(201);
    return out;
  });

  app.post('/auth/login', { preHandler: authLimit }, async (req) => {
    const b = parse(loginSchema, req.body);
    return c.auth.login(b.email, b.password, meta(req));
  });

  app.post('/auth/mfa/verify', { preHandler: authLimit }, async (req) => c.auth.completeMfaLogin(parse(mfaVerifySchema, req.body), meta(req)));

  app.post('/auth/refresh', { preHandler: authLimit }, async (req) => c.auth.refresh(parse(refreshSchema, req.body).refreshToken, meta(req)));

  app.post('/auth/logout', { preHandler: g.auth({ allowPreMfa: true }) }, async (req, reply) => {
    await c.auth.logout(req.actor!);
    reply.status(204);
  });

  app.post('/auth/mfa/enroll', { preHandler: [g.auth({ allowPreMfa: true }), authLimit] }, async (req) => c.auth.startMfaEnrollment(req.actor!));

  app.post('/auth/mfa/activate', { preHandler: [g.auth({ allowPreMfa: true }), authLimit] }, async (req) =>
    c.auth.activateMfa(req.actor!, parse(activateSchema, req.body).code, meta(req)),
  );

  app.post('/auth/password', { preHandler: [g.auth(), authLimit] }, async (req, reply) => {
    const b = parse(passwordChangeSchema, req.body);
    await c.auth.changePassword(req.actor!, b.currentPassword, b.newPassword);
    reply.status(204);
  });

  app.get('/me', { preHandler: g.auth({ allowPreMfa: true }) }, async (req) => c.users.getMe(req.actor!));
  app.patch('/me', { preHandler: [g.auth({ permission: 'profile:manage' }), g.limit('write', c.cfg.rateLimit.writePerMin)] }, async (req) =>
    c.users.updateMe(req.actor!, parse(profileUpdateSchema, req.body)),
  );
}

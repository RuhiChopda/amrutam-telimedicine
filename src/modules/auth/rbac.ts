import type { Role } from '../../shared/context';

export type Permission =
  | 'profile:manage'
  | 'booking:create'
  | 'consultation:read'
  | 'consultation:cancel'
  | 'consultation:cancel:any'
  | 'consultation:start'
  | 'consultation:complete'
  | 'review:create'
  | 'prescription:create'
  | 'prescription:read'
  | 'payment:read'
  | 'availability:manage'
  | 'doctor:profile:manage'
  | 'admin:doctors:verify'
  | 'admin:users:manage'
  | 'admin:jobs:manage'
  | 'admin:analytics:read'
  | 'admin:audit:read';

/**
 * Role → permission matrix (least privilege). Notably:
 *  - admins can manage platform operations but have NO access to clinical content (consultation notes, prescriptions);
 *  - auditors are read-only on audit logs and aggregate analytics.
 * Resource-level ownership ("is this MY consultation?") is enforced in the services, not here.
 */
const MATRIX: Record<Role, readonly Permission[]> = {
  patient: [
    'profile:manage',
    'booking:create',
    'consultation:read',
    'consultation:cancel',
    'review:create',
    'prescription:read',
    'payment:read',
  ],
  doctor: [
    'profile:manage',
    'doctor:profile:manage',
    'availability:manage',
    'consultation:read',
    'consultation:cancel',
    'consultation:start',
    'consultation:complete',
    'prescription:create',
    'prescription:read',
  ],
  admin: [
    'profile:manage',
    'consultation:cancel:any',
    'admin:doctors:verify',
    'admin:users:manage',
    'admin:jobs:manage',
    'admin:analytics:read',
    'admin:audit:read',
  ],
  auditor: ['profile:manage', 'admin:analytics:read', 'admin:audit:read'],
};

const SETS = Object.fromEntries(Object.entries(MATRIX).map(([r, p]) => [r, new Set(p)])) as Record<Role, Set<Permission>>;

export const can = (role: Role, permission: Permission): boolean => SETS[role]?.has(permission) ?? false;
export const permissionsOf = (role: Role): readonly Permission[] => MATRIX[role] ?? [];

/** Roles that must complete a TOTP second factor before any non-enrolment endpoint is usable. */
export const MFA_REQUIRED_ROLES: ReadonlySet<Role> = new Set<Role>(['doctor', 'admin', 'auditor']);
export const mfaRequired = (role: Role): boolean => MFA_REQUIRED_ROLES.has(role);

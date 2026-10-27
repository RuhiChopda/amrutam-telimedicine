/**
 * Additional Authenticated Data for field encryption. Binding each ciphertext to "table.column:rowId" means a ciphertext
 * copied between rows or columns by someone with raw DB access fails GCM authentication on decrypt.
 */
export const AAD = {
  userEmail: (id: string) => `users.email:${id}`,
  userMfaSecret: (id: string) => `users.mfa_secret:${id}`,
  userMfaPending: (id: string) => `users.mfa_pending:${id}`,
  profileName: (id: string) => `profiles.full_name:${id}`,
  profilePhone: (id: string) => `profiles.phone:${id}`,
  profileDob: (id: string) => `profiles.date_of_birth:${id}`,
  consultationReason: (id: string) => `consultations.reason:${id}`,
  consultationNotes: (id: string) => `consultations.notes:${id}`,
  prescription: (id: string) => `prescriptions.content:${id}`,
  paymentSecret: (id: string) => `payments.client_secret:${id}`,
} as const;

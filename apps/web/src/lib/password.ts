/**
 * Password strength hint for the setup wizard. This is a heuristic shown to
 * a human, not a security control: the API enforces the minimum length, and
 * the password is the emergency path behind passkeys and TOTP.
 */

export const PASSWORD_MIN_LENGTH = 12;

export type PasswordStrength = "tooShort" | "weak" | "fair" | "strong" | "veryStrong";

export interface PasswordAssessment {
  strength: PasswordStrength;
  /** 0..4, for a segmented meter. */
  score: 0 | 1 | 2 | 3 | 4;
  meetsMinimum: boolean;
}

const COMMON_SEQUENCES = ["1234", "abcd", "qwer", "asdf", "password", "passwort", "restow"];

function characterClasses(password: string): number {
  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/[0-9]/.test(password)) classes += 1;
  if (/[^A-Za-z0-9]/.test(password)) classes += 1;
  return classes;
}

function hasRepetition(password: string): boolean {
  return /(.)\1{2,}/.test(password);
}

function hasCommonSequence(password: string): boolean {
  const lower = password.toLowerCase();
  return COMMON_SEQUENCES.some((sequence) => lower.includes(sequence));
}

export function assessPassword(password: string): PasswordAssessment {
  const meetsMinimum = password.length >= PASSWORD_MIN_LENGTH;
  if (!meetsMinimum) {
    return { strength: "tooShort", score: 0, meetsMinimum };
  }

  let points = 0;
  points += Math.min(3, Math.floor((password.length - PASSWORD_MIN_LENGTH) / 4));
  points += Math.max(0, characterClasses(password) - 1);
  if (hasRepetition(password)) points -= 1;
  if (hasCommonSequence(password)) points -= 2;

  const score = Math.max(1, Math.min(4, points)) as 1 | 2 | 3 | 4;
  const strength: PasswordStrength =
    score === 1 ? "weak" : score === 2 ? "fair" : score === 3 ? "strong" : "veryStrong";
  return { strength, score, meetsMinimum };
}

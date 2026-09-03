import bcrypt from "bcryptjs";

import { hmacSha256Hex } from "./crypto.js";

const PASSWORD_COST = 12;

const validatePassword = (password: string): void => {
  const bytes = Buffer.byteLength(password, "utf8");
  if (bytes < 12 || bytes > 1_024) {
    throw new Error("Password must contain between 12 and 1024 UTF-8 bytes");
  }
};

const prehash = (password: string, pepper: string): string =>
  hmacSha256Hex(pepper, password);

export const hashPassword = async (
  password: string,
  pepper: string,
): Promise<string> => {
  validatePassword(password);
  return bcrypt.hash(prehash(password, pepper), PASSWORD_COST);
};

export const verifyPassword = async (
  password: string,
  pepper: string,
  expectedHash: string,
): Promise<boolean> => {
  if (Buffer.byteLength(password, "utf8") > 1_024) return false;
  return bcrypt.compare(prehash(password, pepper), expectedHash);
};

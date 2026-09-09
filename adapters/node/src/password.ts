import bcrypt from "bcryptjs";

import { bytesToHex, hmacBytes } from "@one-fetch/core";

const PASSWORD_COST = 12;

const validatePassword = (password: string): void => {
  const bytes = Buffer.byteLength(password, "utf8");
  if (bytes < 12 || bytes > 1_024) {
    throw new Error("Password must contain between 12 and 1024 UTF-8 bytes");
  }
};

const prehashPassword = async (
  password: string,
  pepper: string,
): Promise<string> => bytesToHex(await hmacBytes(pepper, password));

export const hashPassword = async (
  password: string,
  pepper: string,
): Promise<string> => {
  validatePassword(password);
  const prehash = await prehashPassword(password, pepper);
  return bcrypt.hash(prehash, PASSWORD_COST);
};

export const verifyPassword = async (
  password: string,
  pepper: string,
  expectedHash: string,
): Promise<boolean> => {
  if (Buffer.byteLength(password, "utf8") > 1_024) return false;
  const prehash = await prehashPassword(password, pepper);
  return bcrypt.compare(prehash, expectedHash);
};

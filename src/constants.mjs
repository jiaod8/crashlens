import { SIGNATURES } from "./parse.mjs";

/** signature id -> the hypotheses/verification guidance for that failure shape. */
export const SIGNFIX_HINT = Object.fromEntries(
  SIGNATURES.map((s) => [s.id, { hypotheses: s.hypotheses, verify: s.verify }]),
);
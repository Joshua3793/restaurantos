-- One Method, with waits (docs/superpowers/specs/2026-09-06-recipe-method-with-waits-design.md).
-- `Recipe.method` (MethodStep[]) supersedes `steps` + `stages`; those stay as a
-- read-only fallback for one release. Additive and nullable; IF NOT EXISTS so a
-- deploy re-applying it after an out-of-band apply is a no-op.

-- AlterTable
ALTER TABLE "Recipe" ADD COLUMN IF NOT EXISTS "method" JSONB;

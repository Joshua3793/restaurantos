-- Staged prep (docs/superpowers/specs/2026-09-06-staged-prep-and-cadence-suggestions-design.md).
-- Stages live on the recipe as a Json array; a live PrepLog records which stage
-- the job is in. Additive and nullable on purpose: a recipe without stages and
-- the logs of unstaged items are byte-identical to before. IF NOT EXISTS so a
-- deploy re-applying it after an out-of-band apply is a no-op.

-- AlterTable
ALTER TABLE "Recipe" ADD COLUMN IF NOT EXISTS "stages" JSONB;

-- AlterTable
ALTER TABLE "PrepLog" ADD COLUMN IF NOT EXISTS "stageIndex" INTEGER,
ADD COLUMN IF NOT EXISTS "stageEnteredAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "stageHistory" JSONB;

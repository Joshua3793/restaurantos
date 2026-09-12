-- A prep item can be switched off the prep list while its recipe stays active
-- (feature / special recipes that would otherwise clutter Smart Prep). Recipe
-- sync never touches it; `isActive` keeps mirroring the recipe's own state.
ALTER TABLE "PrepItem" ADD COLUMN "prepEnabled" BOOLEAN NOT NULL DEFAULT true;

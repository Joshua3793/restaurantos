-- Zero-velocity "Same as last" support
ALTER TABLE "CountLine" ADD COLUMN "noMovement" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CountLine" ADD COLUMN "carriedForward" BOOLEAN NOT NULL DEFAULT false;

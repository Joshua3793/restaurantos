-- Phase 1a: widen the enum. These MUST be applied before any statement below
-- references 'OWNER' or 'LEAD'.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'OWNER';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'LEAD';

-- CreateEnum
CREATE TYPE "PinDeviceStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED');

-- CreateTable
CREATE TABLE "PinDevice" (
    "id" TEXT NOT NULL,
    "cookId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT,
    "status" "PinDeviceStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedByName" TEXT,
    "approvedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "PinDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PinAttempt" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PinAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PinDevice_status_idx" ON "PinDevice"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PinDevice_tokenHash_cookId_key" ON "PinDevice"("tokenHash", "cookId");

-- CreateIndex
CREATE INDEX "PinAttempt_key_createdAt_idx" ON "PinAttempt"("key", "createdAt");

-- AddForeignKey
ALTER TABLE "PinDevice" ADD CONSTRAINT "PinDevice_cookId_fkey" FOREIGN KEY ("cookId") REFERENCES "Cook"("id") ON DELETE CASCADE ON UPDATE CASCADE;


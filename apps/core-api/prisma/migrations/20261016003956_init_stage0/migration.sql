-- CreateEnum
CREATE TYPE "PreviewRiskLevel" AS ENUM ('L1', 'L2');

-- CreateEnum
CREATE TYPE "PreviewStatus" AS ENUM ('PENDING', 'EXECUTED', 'CANCELLED', 'EXPIRED', 'STALE');

-- CreateTable
CREATE TABLE "ActionPreview" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "riskLevel" "PreviewRiskLevel" NOT NULL,
    "normalizedCommandJson" JSONB NOT NULL,
    "displayJson" JSONB NOT NULL,
    "resourceVersionsJson" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "PreviewStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionPreview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessAuditEvent" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "runId" TEXT,
    "previewId" TEXT,
    "eventType" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "requestId" TEXT NOT NULL,
    "detailJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ActionPreview_idempotencyKey_key" ON "ActionPreview"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ActionPreview_actorUserId_status_expiresAt_idx" ON "ActionPreview"("actorUserId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "BusinessAuditEvent_runId_createdAt_idx" ON "BusinessAuditEvent"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "BusinessAuditEvent_previewId_createdAt_idx" ON "BusinessAuditEvent"("previewId", "createdAt");

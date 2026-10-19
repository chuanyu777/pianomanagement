CREATE TABLE "InternalRequestNonce" (
    "nonce" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InternalRequestNonce_pkey" PRIMARY KEY ("nonce")
);

CREATE INDEX "InternalRequestNonce_expiresAt_idx" ON "InternalRequestNonce"("expiresAt");

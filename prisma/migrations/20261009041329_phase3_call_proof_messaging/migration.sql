-- DropIndex
DROP INDEX "MessageLog_orderId_template_key";

-- AlterTable
ALTER TABLE "MessageLog" ADD COLUMN     "body" TEXT,
ADD COLUMN     "cost" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "error" TEXT,
ADD COLUMN     "lang" TEXT,
ADD COLUMN     "orgId" TEXT,
ADD COLUMN     "providerId" TEXT,
ADD COLUMN     "readAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "trackingToken" TEXT;

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT,
    "key" TEXT NOT NULL,
    "channel" "MsgChannel" NOT NULL,
    "lang" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "waTemplateName" TEXT,
    "waLanguage" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageCreditLedger" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "messageLogId" TEXT,
    "note" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageCreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShortLink" (
    "code" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "orderId" TEXT,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShortLink_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "CallSession" (
    "id" TEXT NOT NULL,
    "callRef" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "phoneNumberId" TEXT,
    "to" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DIALING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSec" INTEGER,
    "recordingUrl" TEXT,
    "proof" "CallProof" NOT NULL DEFAULT 'NONE',
    "attemptId" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "CallSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_merchantId_key_channel_lang_key" ON "MessageTemplate"("merchantId", "key", "channel", "lang");

-- CreateIndex
CREATE INDEX "MessageCreditLedger_orgId_createdAt_idx" ON "MessageCreditLedger"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CallSession_callRef_key" ON "CallSession"("callRef");

-- CreateIndex
CREATE INDEX "CallSession_orderId_startedAt_idx" ON "CallSession"("orderId", "startedAt");

-- CreateIndex
CREATE INDEX "CallSession_agentId_startedAt_idx" ON "CallSession"("agentId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceToken_tokenHash_key" ON "DeviceToken"("tokenHash");

-- CreateIndex
CREATE INDEX "DeviceToken_userId_idx" ON "DeviceToken"("userId");

-- CreateIndex
CREATE INDEX "MessageLog_providerId_idx" ON "MessageLog"("providerId");

-- CreateIndex
CREATE INDEX "MessageLog_orgId_sentAt_idx" ON "MessageLog"("orgId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageLog_orderId_template_channel_key" ON "MessageLog"("orderId", "template", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "Order_trackingToken_key" ON "Order"("trackingToken");

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageCreditLedger" ADD CONSTRAINT "MessageCreditLedger_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


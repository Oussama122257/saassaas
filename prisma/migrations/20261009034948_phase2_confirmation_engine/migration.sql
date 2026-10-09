-- CreateEnum
CREATE TYPE "FakeReason" AS ENUM ('INVALID_PHONE', 'NAME_NONSENSE', 'DID_NOT_ORDER', 'PRANK', 'TEST_ORDER', 'COMPETITOR', 'REPEAT_REFUSER', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CancelReason" ADD VALUE 'CANCELLED_BY_CUSTOMER';
ALTER TYPE "CancelReason" ADD VALUE 'WRONG_INFORMATION';
ALTER TYPE "CancelReason" ADD VALUE 'NO_LONGER_INTERESTED';
ALTER TYPE "CancelReason" ADD VALUE 'CUSTOMER_ABSENT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderStatus" ADD VALUE 'EN_COURS_CONFIRMATION';
ALTER TYPE "OrderStatus" ADD VALUE 'CONFIRMEE_REPORTEE';
ALTER TYPE "OrderStatus" ADD VALUE 'EXPIREE';
ALTER TYPE "OrderStatus" ADD VALUE 'EN_PREPARATION';
ALTER TYPE "OrderStatus" ADD VALUE 'EXPEDITION_RETARDEE';
ALTER TYPE "OrderStatus" ADD VALUE 'STOPDESK_SANS_REPONSE';
ALTER TYPE "OrderStatus" ADD VALUE 'EXPEDIE_REPORTE';

-- AlterTable
ALTER TABLE "CallAttempt" ADD COLUMN     "round" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "lastAssignedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "abandonedCartRecovery" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "address2" TEXT,
ADD COLUMN     "clientIp" TEXT,
ADD COLUMN     "crossSellValue" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "expiredAt" TIMESTAMP(3),
ADD COLUMN     "externalName" TEXT,
ADD COLUMN     "fakeReason" "FakeReason",
ADD COLUMN     "freeDelivery" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isRepeatCustomer" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lockPrevStatus" "OrderStatus",
ADD COLUMN     "lockedAt" TIMESTAMP(3),
ADD COLUMN     "lockedById" TEXT,
ADD COLUMN     "mappingErrors" TEXT[],
ADD COLUMN     "recycleRound" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "upsellValue" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Pod" ADD COLUMN     "teamId" TEXT;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "connection" TEXT NOT NULL DEFAULT 'CONNECTED',
ADD COLUMN     "externalRef" TEXT,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastSyncAt" TIMESTAMP(3),
ADD COLUMN     "settings" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "stage" "StatusGroup" NOT NULL,
    "tags" TEXT[],
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnmatchedLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "externalSku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "variantName" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" INTEGER NOT NULL DEFAULT 0,
    "resolvedProductId" TEXT,
    "resolvedVariantId" TEXT,

    CONSTRAINT "UnmatchedLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkuMapping" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "storeId" TEXT,
    "externalSku" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkuMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "storeId" TEXT,
    "topic" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "orderId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeIpWindow" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "IntakeIpWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL,
    "result" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPermission" (
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,

    CONSTRAINT "UserPermission_pkey" PRIMARY KEY ("userId","orgId","key")
);

-- CreateIndex
CREATE INDEX "Comment_orderId_createdAt_idx" ON "Comment"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "Comment_authorId_createdAt_idx" ON "Comment"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "UnmatchedLine_orderId_idx" ON "UnmatchedLine"("orderId");

-- CreateIndex
CREATE INDEX "UnmatchedLine_externalSku_idx" ON "UnmatchedLine"("externalSku");

-- CreateIndex
CREATE UNIQUE INDEX "SkuMapping_merchantId_externalSku_key" ON "SkuMapping"("merchantId", "externalSku");

-- CreateIndex
CREATE INDEX "WebhookReceipt_storeId_receivedAt_idx" ON "WebhookReceipt"("storeId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookReceipt_provider_deliveryId_key" ON "WebhookReceipt"("provider", "deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeIpWindow_merchantId_ip_windowStart_key" ON "IntakeIpWindow"("merchantId", "ip", "windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_key_key" ON "JobRun"("key");

-- CreateIndex
CREATE INDEX "Team_orgId_idx" ON "Team"("orgId");

-- CreateIndex
CREATE INDEX "Order_status_lockedAt_idx" ON "Order"("status", "lockedAt");

-- CreateIndex
CREATE INDEX "Order_merchantId_deletedAt_idx" ON "Order"("merchantId", "deletedAt");

-- CreateIndex
CREATE INDEX "Store_channel_externalRef_idx" ON "Store"("channel", "externalRef");

-- AddForeignKey
ALTER TABLE "Pod" ADD CONSTRAINT "Pod_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_lockedById_fkey" FOREIGN KEY ("lockedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnmatchedLine" ADD CONSTRAINT "UnmatchedLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkuMapping" ADD CONSTRAINT "SkuMapping_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkuMapping" ADD CONSTRAINT "SkuMapping_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookReceipt" ADD CONSTRAINT "WebhookReceipt_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeIpWindow" ADD CONSTRAINT "IntakeIpWindow_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermission" ADD CONSTRAINT "UserPermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermission" ADD CONSTRAINT "UserPermission_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

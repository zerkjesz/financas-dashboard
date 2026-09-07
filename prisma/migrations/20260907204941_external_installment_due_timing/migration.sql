-- CreateEnum
CREATE TYPE "ExternalInstallmentDueTiming" AS ENUM ('CALENDAR_DATE', 'AFTER_NEXT_INCOME');

-- AlterTable
ALTER TABLE "ExternalInstallment" ALTER COLUMN "dueDate" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ExternalInstallmentPlan" ADD COLUMN     "dueTiming" "ExternalInstallmentDueTiming" NOT NULL DEFAULT 'CALENDAR_DATE',
ALTER COLUMN "firstDueDate" DROP NOT NULL;

-- Shared, product-scoped synthetic demo records only.
CREATE TABLE "sectrai_demo_records" (
  "id" TEXT NOT NULL,
  "product" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "moduleId" TEXT NOT NULL,
  "values" JSONB NOT NULL,
  "status" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT NOT NULL,
  CONSTRAINT "sectrai_demo_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sectrai_demo_records_product_workspaceId_moduleId_createdAt_idx"
  ON "sectrai_demo_records"("product", "workspaceId", "moduleId", "createdAt");
CREATE INDEX "sectrai_demo_records_product_workspaceId_moduleId_id_idx"
  ON "sectrai_demo_records"("product", "workspaceId", "moduleId", "id");

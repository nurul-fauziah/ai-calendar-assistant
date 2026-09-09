-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "recurrence" TEXT;
ALTER TABLE "scheduled_tasks" ADD COLUMN "recurrence" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_tasks_user_id_task_id_status_key" ON "scheduled_tasks"("user_id", "task_id", "status");
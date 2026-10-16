-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'TEACHER');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Teacher" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Teacher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Student" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultUnitPrice" DECIMAL(14,2) NOT NULL,
    "defaultDurationMinutes" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentCourseAccount" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "currentUnitPrice" DECIMAL(14,2) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentCourseAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Teacher_userId_key" ON "Teacher"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentCourseAccount_studentId_courseId_key" ON "StudentCourseAccount"("studentId", "courseId");

-- CreateIndex
CREATE INDEX "StudentCourseAccount_courseId_idx" ON "StudentCourseAccount"("courseId");

-- AddCheckConstraint
ALTER TABLE "User" ADD CONSTRAINT "User_username_nonempty_check" CHECK (btrim("username") <> '');

-- AddCheckConstraint
ALTER TABLE "User" ADD CONSTRAINT "User_passwordHash_nonempty_check" CHECK (btrim("passwordHash") <> '');

-- AddCheckConstraint
ALTER TABLE "Teacher" ADD CONSTRAINT "Teacher_name_nonempty_check" CHECK (btrim("name") <> '');

-- AddCheckConstraint
ALTER TABLE "Student" ADD CONSTRAINT "Student_name_nonempty_check" CHECK (btrim("name") <> '');

-- AddCheckConstraint
ALTER TABLE "Course" ADD CONSTRAINT "Course_name_nonempty_check" CHECK (btrim("name") <> '');

-- AddCheckConstraint
ALTER TABLE "Course" ADD CONSTRAINT "Course_defaultUnitPrice_nonnegative_check" CHECK ("defaultUnitPrice" >= 0);

-- AddCheckConstraint
ALTER TABLE "Course" ADD CONSTRAINT "Course_defaultDurationMinutes_positive_check" CHECK ("defaultDurationMinutes" > 0);

-- AddCheckConstraint
ALTER TABLE "StudentCourseAccount" ADD CONSTRAINT "StudentCourseAccount_currentUnitPrice_nonnegative_check" CHECK ("currentUnitPrice" >= 0);

-- AddCheckConstraint
ALTER TABLE "StudentCourseAccount" ADD CONSTRAINT "StudentCourseAccount_version_nonnegative_check" CHECK ("version" >= 0);

-- AddForeignKey
ALTER TABLE "Teacher" ADD CONSTRAINT "Teacher_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentCourseAccount" ADD CONSTRAINT "StudentCourseAccount_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentCourseAccount" ADD CONSTRAINT "StudentCourseAccount_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

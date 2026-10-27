-- Allow teacher business profiles to exist independently of login accounts.
ALTER TABLE "Teacher" ALTER COLUMN "userId" DROP NOT NULL;

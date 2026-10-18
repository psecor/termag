-- The AMI a box was launched from and how it was chosen (the box-image flag:
-- published, channel:<name>, pinned, fallback:<asked>). Additive only.

-- AlterTable
ALTER TABLE "instances" ADD COLUMN     "imageId" TEXT,
ADD COLUMN     "imageSource" TEXT;

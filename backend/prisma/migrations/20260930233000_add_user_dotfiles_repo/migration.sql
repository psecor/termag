-- Optional personal dotfiles repository. Null means claim applies nothing.
ALTER TABLE "users" ADD COLUMN "dotfilesRepoUrl" TEXT;

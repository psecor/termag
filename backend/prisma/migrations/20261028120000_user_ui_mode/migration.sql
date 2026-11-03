-- Where a person's later visits open: "simple" (termag, the chat UI) or "full"
-- (Lab, the terminal workspace), chosen in first-run setup and kept as they
-- switch. NULL means not chosen;
-- each browser then keeps its own. Read and written only under
-- onboarding-refresh-enabled.
ALTER TABLE "users" ADD COLUMN "uiMode" TEXT;

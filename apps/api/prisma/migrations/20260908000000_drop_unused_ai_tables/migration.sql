-- Drops the two tables behind the unbuilt AI-assistant surface.
--
-- `Conversation` and `Message` were created by the initial migration for a chat feature
-- that was never implemented: no code path ever inserted a row, and the routes that would
-- have done so answered 404. The assistant story Platter actually ships is MCP, where the
-- transcript lives in the client and Platter stores only proposals.
--
-- Dropping is safe rather than merely tidy: both tables are provably empty on every
-- installation, because the only writer that ever existed is the one that was never
-- written. Keeping them would leave `prisma db pull` and every schema reader describing a
-- feature the product does not have.
--
-- `Message` first: it holds the foreign key.
DROP TABLE IF EXISTS "Message";
DROP TABLE IF EXISTS "Conversation";

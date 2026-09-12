-- Cook-along progress (scale, ticked ingredients, ticked method steps) rides the
-- item's ONE live log while the item is on the To Do; cleared on completion,
-- skip, or removal from the list.
ALTER TABLE "PrepLog" ADD COLUMN "progress" JSONB;

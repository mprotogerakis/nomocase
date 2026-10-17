-- Self-service login links are counted where they are made (one statement decides, so parallel requests
-- cannot all see the same free capacity); before, the daily cap counted sent mails afterwards.
ALTER TABLE login_links ADD COLUMN kind TEXT;

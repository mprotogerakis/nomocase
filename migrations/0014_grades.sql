-- Decision steps that record a grade (1,0–4,0 in steps of 0,1, otherwise 5,0; § 19 Abs. 3 RahmenPO EI), from template "grade": true.
ALTER TABLE tasks ADD COLUMN grade INTEGER NOT NULL DEFAULT 0;

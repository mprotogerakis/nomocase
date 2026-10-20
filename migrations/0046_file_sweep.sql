-- Where the daily file sweep stopped: the last key it looked at (R2 lists keys in lexicographic order). With more files
-- than one run has room for, the next run goes on from there; only a complete pass starts over at the beginning.
CREATE TABLE file_sweep (id INTEGER PRIMARY KEY CHECK (id = 1), after TEXT);
INSERT INTO file_sweep (id, after) VALUES (1, NULL);
